// copilot-webview: reusable helper class for hosting a native webview window
// from a Copilot CLI extension and exchanging eval/RPC messages with it.
//
// Public API:
//   bootstrap(extDir)
//       Installs npm deps if package-lock is missing/stale. Logs via the SDK.
//   new CopilotWebview({ extensionName, contentDir, callbacks?, title?, width?, height? })
//       One window per instance. Properties / methods:
//         .tools                 → array of tool defs (`<extensionName>_show`,
//                                  `<extensionName>_eval`, `<extensionName>_close`)
//                                  to spread into joinSession({ tools }).
//         .show({ reload? })     → opens the window if not already open. If
//                                  already open and `reload: true`, reloads
//                                  the page; otherwise leaves it untouched.
//                                  Returns the window handle either way.
//         .eval(code, opts?)     → run JS in the page; rejects if not open.
//         .emit(name, detail)    → dispatch an event to the page.
//         .close()               → close the window if open. Pre-bound so it
//                                  can be passed directly as hooks.onSessionEnd.
import { execSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { joinSession } from "@github/copilot-sdk/extension";
import { Application } from "@webviewjs/webview";

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
};

// Installed before page scripts.
//
// `copilotEvents` is the host -> page event channel:
//
//     window.copilotEvents.addEventListener("update", (event) => {
//         console.log(event.detail);
//     });
//
// `__copilotWebview.evaluate` is internal. It lets the host evaluate arbitrary
// JavaScript, including async code, without implementing a WebSocket transport.
const PRELOAD_JS = `(() => {
    const events = new EventTarget();

    window.copilotEvents = events;

    window.__copilotWebview = {
        async evaluate(id, code) {
            try {
                const value = await (0, eval)(code);

                let payload;

                try {
                    const json = JSON.stringify(value);

                    payload = json === undefined
                        ? { type: "undefined" }
                        : { type: "value", value };
                } catch {
                    payload = {
                        type: "value",
                        value: String(value),
                    };
                }

                try {
                    await window.__copilotHost.resolveEval(id, payload);
                } catch {}
            } catch (error) {
                try {
                    await window.__copilotHost.rejectEval(
                        id,
                        error?.stack || String(error)
                    );
                } catch {}
            }
        },

        emit(name, detail) {
            events.dispatchEvent(
                new CustomEvent(name, { detail })
            );
        },
    };
})();`;

function staticProtocol(rootDir) {
    const root = resolve(rootDir);

    return async (request) => {
        let pathname;

        try {
            const url = new URL(request.url);
            pathname =
                decodeURIComponent(url.pathname).replace(/^\/+/, "") ||
                "index.html";
        } catch {
            return {
                statusCode: 400,
                body: Buffer.from("Bad request"),
                mimeType: "text/plain",
            };
        }

        const filePath = resolve(root, pathname);
        const relativePath = relative(root, filePath);

        if (
            relativePath.startsWith("..") ||
            isAbsolute(relativePath)
        ) {
            return {
                statusCode: 403,
                body: Buffer.from("Forbidden"),
                mimeType: "text/plain",
            };
        }

        try {
            return {
                statusCode: 200,
                body: await readFile(filePath),
                mimeType:
                    MIME[extname(filePath)] ||
                    "application/octet-stream",
            };
        } catch {
            return {
                statusCode: 404,
                body: Buffer.from("Not found"),
                mimeType: "text/plain",
            };
        }
    };
}

export async function bootstrap(extDir) {
    const pkg = join(extDir, "package.json");
    const lock = join(extDir, "package-lock.json");

    if (
        existsSync(lock) &&
        statSync(pkg).mtimeMs <= statSync(lock).mtimeMs
    ) {
        return;
    }

    const session = await joinSession();

    await session.log("Installing extension dependencies…");

    execSync("npm install --no-audit --no-fund", {
        cwd: extDir,
        stdio: "ignore",
    });

    await session.log("Dependencies installed.");
    await session.disconnect();
}

async function showWebview({
    dir,
    title = "Copilot Webview",
    width = 900,
    height = 700,
    callbacks = {},
} = {}) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`directory does not exist: ${dir}`);
    }

    if (!existsSync(join(dir, "index.html"))) {
        throw new Error(`${dir} does not contain an index.html file`);
    }

    const id = randomBytes(4).toString("hex");
    const closeListeners = [];
    const pendingEvals = new Map();

    // On Windows, use a per-window WebView2 data directory so it can be
    // cleaned up after the window closes.
    const userDataDir =
        process.platform === "win32"
            ? join(tmpdir(), `copilot-webview-${id}`)
            : null;

    const app = new Application();
    await app.whenReady();

    const webContext = userDataDir
        ? app.createWebContext({
              dataDirectory: userDataDir,
          })
        : undefined;

    const win = app.createBrowserWindow({
        title,
        width,
        height,
    });

    win.registerProtocol(
        "app",
        staticProtocol(dir)
    );

    let closed = false;
    let webview;
    let pageReady;

    const resolveEval = (id, payload) => {
        const pending = pendingEvals.get(id);

        if (!pending) {
            return null;
        }

        pendingEvals.delete(id);
        clearTimeout(pending.timer);

        if (payload?.type === "undefined") {
            pending.resolve(undefined);
        } else {
            pending.resolve(payload?.value);
        }

        return null;
    };

    const rejectEval = (id, message) => {
        const pending = pendingEvals.get(id);

        if (!pending) {
            return null;
        }

        pendingEvals.delete(id);
        clearTimeout(pending.timer);

        pending.reject(
            new Error(String(message || "evaluation failed"))
        );

        return null;
    };

    const createPage = () => {
        let resolveReady;

        const ready = new Promise((resolve) => {
            resolveReady = resolve;
        });

        const view = win.createWebview({
            url: "app://localhost/index.html",
            enableDevtools: true,
            webContext,
            preload: PRELOAD_JS,
        });

        view.once("page-load-finished", () => {
            resolveReady();
        });

        // Page -> extension RPC.
        //
        // Existing extension callbacks are exposed directly as:
        //
        //     await window.copilot.someCallback(...)
        //
        // WebviewJS handles Promise completion, serialization, errors and IPC.
        view.expose("copilot", callbacks);

        // Private channel used only to complete host-initiated eval requests.
        view.expose("__copilotHost", {
            resolveEval,
            rejectEval,
        });

        return {
            view,
            ready,
        };
    };

    {
        const page = createPage();

        webview = page.view;
        pageReady = page.ready;
    }

    const rejectPendingEvals = (error) => {
        for (const pending of pendingEvals.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        pendingEvals.clear();
    };

    const cleanup = () => {
        if (closed) {
            return;
        }

        closed = true;

        rejectPendingEvals(
            new Error("webview closed")
        );

        for (const cb of closeListeners) {
            try {
                cb(0);
            } catch {}
        }

        if (userDataDir) {
            // WebView2 may still hold file locks for a moment after exit on Windows.
            (async () => {
                for (let i = 0; i < 5; i++) {
                    try {
                        await rm(userDataDir, {
                            recursive: true,
                            force: true,
                            maxRetries: 3,
                        });

                        return;
                    } catch {
                        await new Promise((resolve) =>
                            setTimeout(
                                resolve,
                                200 * (i + 1)
                            )
                        );
                    }
                }
            })();
        }
    };

    app.on("application-close-requested", () => {
        app.exit();
        cleanup();
    });

    const handle = {
        async eval(
            code,
            { timeoutMs = 3000 } = {}
        ) {
            if (closed || webview.isDisposed()) {
                throw new Error(
                    "webview is not open"
                );
            }

            await pageReady;

            const reqId = randomUUID();

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pendingEvals.delete(reqId);

                    reject(
                        new Error(
                            `timeout (${timeoutMs}ms)`
                        )
                    );
                }, timeoutMs);

                pendingEvals.set(reqId, {
                    resolve,
                    reject,
                    timer,
                });

                try {
                    webview.evaluateScript(
                        `window.__copilotWebview.evaluate(` +
                            `${JSON.stringify(reqId)},` +
                            `${JSON.stringify(String(code))}` +
                            `)`
                    );
                } catch (error) {
                    pendingEvals.delete(reqId);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        },

        async emit(name, detail) {
            if (closed || webview.isDisposed()) {
                throw new Error(
                    "webview is not open"
                );
            }

            if (typeof name !== "string") {
                throw new TypeError(
                    "event name must be a string"
                );
            }

            await pageReady;

            let serializedDetail;

            if (detail === undefined) {
                serializedDetail = "undefined";
            } else {
                try {
                    serializedDetail =
                        JSON.stringify(detail);
                } catch {
                    throw new TypeError(
                        "event detail must be JSON-serializable"
                    );
                }

                if (serializedDetail === undefined) {
                    throw new TypeError(
                        "event detail must be JSON-serializable"
                    );
                }
            }

            webview.evaluateScript(
                `window.__copilotWebview.emit(` +
                    `${JSON.stringify(name)},` +
                    `${serializedDetail}` +
                    `)`
            );
        },

        async reload() {
            if (closed) {
                throw new Error(
                    "webview is not open"
                );
            }

            rejectPendingEvals(
                new Error("webview reloaded")
            );

            // Recreate the webview rather than only navigating the existing
            // document so exposed namespaces are installed on the fresh page.
            if (!webview.isDisposed()) {
                webview.dispose();
            }

            const page = createPage();

            webview = page.view;
            pageReady = page.ready;

            await pageReady;
        },

        close() {
            if (closed) {
                return;
            }

            app.exit();
            cleanup();
        },

        onClose(cb) {
            closeListeners.push(cb);
        },
    };

    await pageReady;

    return handle;
}

// Copilot CLI extension wrapper around showWebview. One instance manages a
// single window for one extension. Tools are exposed via `.tools`. The slash
// command lives in main.mjs and just calls `.show()`.
export class CopilotWebview {
    constructor({
        extensionName,
        contentDir,
        callbacks = {},
        title,
        width,
        height,
    } = {}) {
        if (
            !extensionName ||
            typeof extensionName !== "string"
        ) {
            throw new Error(
                "CopilotWebview: `extensionName` is required (used to prefix tool names)."
            );
        }

        if (
            !contentDir ||
            typeof contentDir !== "string"
        ) {
            throw new Error(
                "CopilotWebview: `contentDir` is required (path to the directory containing index.html)."
            );
        }

        this.extensionName = extensionName;
        this.prefix = extensionName.replace(
            /[^a-zA-Z0-9_]/g,
            "_"
        );

        this.contentDir = isAbsolute(contentDir)
            ? contentDir
            : resolve(
                  process.cwd(),
                  contentDir
              );

        this.callbacks = callbacks;
        this.title = title;
        this.width = width;
        this.height = height;
        this._handle = null;

        this.close = this.close.bind(this);
    }

    async show({ reload = false } = {}) {
        if (this._handle) {
            if (reload) {
                await this._handle.reload();
            }

            return this._handle;
        }

        const handle = await showWebview({
            dir: this.contentDir,
            title: this.title,
            width: this.width,
            height: this.height,
            callbacks: this.callbacks,
        });

        this._handle = handle;

        handle.onClose(() => {
            if (this._handle === handle) {
                this._handle = null;
            }
        });

        return handle;
    }

    eval(code, opts) {
        if (!this._handle) {
            return Promise.reject(
                new Error("webview is not open")
            );
        }

        return this._handle.eval(
            code,
            opts
        );
    }

    emit(name, detail) {
        if (!this._handle) {
            return Promise.reject(
                new Error("webview is not open")
            );
        }

        return this._handle.emit(
            name,
            detail
        );
    }

    close() {
        if (this._handle) {
            this._handle.close();
        }
    }

    get tools() {
        const { prefix } = this;

        return [
            {
                name: `${prefix}_show`,
                description:
                    "Open the extension's native desktop window. If already open, by default leaves it untouched; pass reload=true to refresh the page.",
                parameters: {
                    type: "object",
                    properties: {
                        reload: {
                            type: "boolean",
                            description:
                                "If the window is already open, reload the page. Default false.",
                        },
                    },
                },
                handler: async ({
                    reload = false,
                } = {}) => {
                    try {
                        const wasOpen =
                            !!this._handle;

                        await this.show({
                            reload,
                        });

                        if (!wasOpen) {
                            return "Webview window opened.";
                        }

                        return reload
                            ? "Webview already open; refreshed."
                            : "Webview already open.";
                    } catch (e) {
                        return `Error: ${e.message}`;
                    }
                },
            },
            {
                name: `${prefix}_eval`,
                description:
                    "Evaluate JavaScript inside the open webview window and return the result. Useful for DOM queries, reading state, or driving the page.",
                parameters: {
                    type: "object",
                    properties: {
                        code: {
                            type: "string",
                            description:
                                "JavaScript code to evaluate. The result of the last expression is returned.",
                        },
                        timeout: {
                            type: "number",
                            description:
                                "Timeout in seconds. Default 3, max 10.",
                        },
                    },
                    required: ["code"],
                },
                handler: async ({
                    code,
                    timeout,
                }) => {
                    const timeoutMs =
                        Math.min(
                            Math.max(
                                Number(timeout) ||
                                    3,
                                0.1
                            ),
                            10
                        ) * 1000;

                    try {
                        const result =
                            await this.eval(
                                code,
                                {
                                    timeoutMs,
                                }
                            );

                        return typeof result ===
                            "string"
                            ? result
                            : JSON.stringify(
                                  result
                              );
                    } catch (e) {
                        return `Error: ${e.message}`;
                    }
                },
            },
            {
                name: `${prefix}_close`,
                description:
                    "Close the webview window if it is open.",
                parameters: {
                    type: "object",
                    properties: {},
                },
                handler: async () => {
                    this.close();
                    return "Closed.";
                },
            },
        ];
    }
}