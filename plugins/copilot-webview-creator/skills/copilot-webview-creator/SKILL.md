---
name: copilot-webview-creator
description: Author a Copilot CLI extension that opens a native desktop window (webview) and exchanges live messages with page-side JavaScript. Use this skill whenever the user wants to build, scaffold, or extend a Copilot CLI extension that needs a GUI, a dashboard, an interactive panel, an HTML/React UI driven by the agent, real-time visualizations updated from the extension, or two-way communication between agent code and a webview page. Trigger this skill on requests like "make an extension that shows a UI", "open a window from my extension", "build a Copilot dashboard", "show a webview", "render React from my Copilot extension", "let the page call back into my extension", or anything that combines a Copilot CLI extension with visual/interactive output.
---

# Copilot Webview Creator

Scaffold a Copilot CLI extension that opens a native window backed by a small reusable library (`copilot-webview`). The library handles all the messy parts — child-process management for the native event loop, an HTTP+WebSocket server, a page-side `window.copilot` bridge, per-window data-folder cleanup — so the extension author only writes:

1. The list of **callbacks** the page can invoke on the extension.
2. The **HTML/JS/CSS** (or React/TSX) shown inside the window.

The skill works by **recursively copying the `template/` directory** into the user's repo and then customizing it. The template is the source of truth; do not paraphrase its files into the conversation when scaffolding — copy them. Optional alternative content stacks (e.g. React) live as peers under `content-examples/`.

## When to use this skill

Use whenever the user wants any combination of:

- A new Copilot CLI extension that has a UI.
- An existing extension to gain a UI.
- A native window opened from agent-driven tools.
- React/TSX (or any modern frontend stack) running inside an agent-controlled window.
- Page → extension callbacks (e.g. button clicks invoking extension code).
- Extension → page push (e.g. live data updates via `webview_eval`).

If the user says they want the agent itself to be able to spawn windows during a session (rather than building an extension), the same scaffolding still applies — they need the extension first.

## Prerequisite: know the Copilot extension SDK

This skill scaffolds *on top of* the standard Copilot CLI extension contract (`extension.mjs`, `joinSession`, tools, slash commands, hooks). Before scaffolding, **call the `extensions_manage` tool with `operation: "guide"`** to load the authoritative extension authoring guide. Use it to look up:

- The shape of `joinSession({ tools, commands, hooks })` and tool/command handler signatures.
- How `session.log()` and other SDK helpers behave.
- Where extensions live (`.github/extensions/<name>/`) and how to reload them after edits.
- The `extensions_reload` tool you'll call after scaffolding so the new extension loads without restarting Copilot.

Don't guess SDK behavior — consult the guide whenever a question comes up about extension lifecycle, tool definitions, command registration, or hooks.

## The architecture (read once, then trust the template)

`@webviewjs/webview` calls `app.run()` which **freezes the host Node event loop** for the lifetime of the window. So the library spawns a tiny child process whose only job is to host the window; all real work happens in the parent extension and in the page itself, talking over **one WebSocket** served from the parent.

```
┌────────────────────┐     WebSocket      ┌──────────────────────────┐
│ PARENT (extension) │ ◄────────────────► │ PAGE (Chromium, alive)   │
│ Node alive ✅      │                     │ window.copilot Proxy     │
│ HTTP+WS server     │                     │ + index.html / React app │
└─────────┬──────────┘                     └──────────────────────────┘
          │ spawns (just to call app.run())
          ▼
┌────────────────────┐
│ CHILD launcher     │  Node frozen ❌ — bypassed for all real comms
└────────────────────┘
```

Wire protocol (handled entirely by the lib — extension code never touches it):

- Parent → page: `{ id, code }`  → page evals JS, replies with `{ id, result, error }`. Used by `webview_eval`.
- Page → parent: `{ id, method, args }` → parent looks `method` up in the `callbacks` dict, awaits it, replies with `{ id, result, error }`. Used by `copilot.<method>(...)` from page-side JS.

## What the skill produces

After running this skill, the user will have a copy of `template/`:

```
.github/extensions/<their-extension-name>/
├── .gitignore           ← node_modules/
├── extension.mjs        ← bootstrapper (installs deps then imports main.mjs)
├── main.mjs             ← extension-specific glue: callbacks + tools registration
├── package.json         ← deps: @webviewjs/webview, ws
├── lib/
│   ├── copilot-webview.js   ← copy verbatim, do not edit
│   └── webview-child.mjs    ← copy verbatim, do not edit
└── content/             ← page directory served to the webview (vanilla HTML/JS)
    ├── index.html       ← MUST exist; MUST load /__bridge.js before any copilot.* use
    ├── style.css
    └── main.js
```

If they wanted a different content stack (e.g. React), `content/` is replaced with the chosen example from `content-examples/`.

The extension automatically registers:
- A slash command `/<extensionName>` (e.g. `/myapp`) defined inline in `main.mjs` so it's easy to customize — by default it just opens the window with no agent involvement, but the handler is right there to extend (e.g. accept args, post a follow-up prompt to the agent, open with a specific size).
- Three tools the agent can call: `<extensionName>_show`, `<extensionName>_eval`, `<extensionName>_close`. The prefix prevents collisions when multiple installed extensions use this lib.

## How to scaffold (do this in order)

Assume the skill directory is `.github/skills/copilot-webview-creator/` (i.e. **this directory**) and refer to `template/` inside it.

1. **Pick the extension name and target dir.** Convention: `.github/extensions/<name>/`. Confirm with the user if ambiguous.

2. **Recursively copy `template/` into the target dir.** One command does it: `Copy-Item -Recurse template/* <target>/` on Windows, `cp -r template/. <target>/` on Unix. This gives them the full scaffolding (lib, extension.mjs, main.mjs, package.json, .gitignore) with the vanilla `content/` ready to go.

3. **(Optional) Swap the content stack.** If the user wants something other than vanilla HTML/JS — typically React — delete the just-copied `<target>/content/` and replace it with one of the peer examples (e.g. recursively copy `content-examples/react/` to `<target>/content/`). See content patterns below.

4. **Customize `main.mjs`.** The template has `"my_dashboard"` as a **placeholder** for `extensionName` and `"my-dashboard"` as a placeholder for the slash-command name — **always replace both with names that fit the user's extension** (e.g. for an extension at `.github/extensions/build-monitor/`, use `extensionName: "build_monitor"` and slash command `name: "build-monitor"`). Conventions:
   - `extensionName` must be safe as a JS identifier and a tool-name prefix — letters, digits, underscores only (no hyphens or spaces).
   - The slash command `name` is what the user types after `/`. Hyphens are fine here; pick whatever reads best in chat.
   - Update the `description` string on the slash command to describe what *this* extension's window does.

   Then keep `contentDir` as `join(import.meta.dirname, "content")` unless serving a different directory, and replace/extend the example `log` callback with whatever the page actually needs to call back into the extension.

5. **Customize the `content/` page** for the user's actual UI. Keep `<script src="/__bridge.js"></script>` in `index.html` — that's what injects `window.copilot`.

6. **Install deps.** `extension.mjs` calls `bootstrap()` which automatically runs `npm install` inside `<target>/` on first load (and after `package.json` changes), so the **top-level install will happen on its own** the first time the extension is loaded. You only need to run `npm install` manually if you want to verify the install before loading the extension, or if you hit the React variant — `<target>/content/` has its own `package.json` that is **not** covered by `bootstrap()` and must be installed (and built) manually.

7. **For React content only:** run `npm run build` inside `<target>/content/` to produce `dist/main.js`. The build is **manual** — there is no auto-rebuild on file changes; tell the user to re-run `npm run build` (or `npm run watch`) when they edit TSX.

8. **Verify.** Reload Copilot extensions; you should see the slash command and the three tools (`<extensionName>_show`, `<extensionName>_eval`, `<extensionName>_close`) registered under the names you chose. Running the slash command opens the window directly; the agent can also open it via the show tool.

Do not invent your own version of `lib/copilot-webview.js` or `lib/webview-child.mjs`. They are tested and contain platform-specific subtleties (Windows-only `WEBVIEW2_USER_DATA_FOLDER` cleanup, etc.). Always copy from `template/lib/`.

## Content patterns

Pick based on what the user wants to build. You can switch later — the only thing that changes is the `content/` directory.

### Pattern A — Vanilla HTML/JS (default; already in `template/content/`)

- Zero build step. Edit files and reload the window.
- Use this for dashboards, simple forms, visualizations, anything not framework-heavy.
- Already included in the recursive template copy — nothing extra to do.
- Files: `index.html` (loads `/__bridge.js` then your `main.js`), `style.css`, `main.js`.

### Pattern B — React + TSX via esbuild

- Use when the user explicitly asks for React, JSX, TSX, or a SPA-style component model.
- Source: `content-examples/react/` (peer of `template/`). Replace `<target>/content/` with this directory.
- Has its own `package.json` with `react`, `react-dom`, and `esbuild` (devDep).
- Build command (no config file needed):
  ```
  esbuild src/main.tsx --bundle --outfile=dist/main.js --format=esm --loader:.tsx=tsx --jsx=automatic --jsx-import-source=react
  ```
- `index.html` loads the built `dist/main.js`. **It must be rebuilt manually after every edit** (`npm run build` or `npm run watch`).
- `node_modules/` and `dist/` are gitignored. After a clean checkout, both `npm install` and `npm run build` need to run before the page works. We deliberately do not auto-build on extension load — keep this in mind when explaining to the user.

If the user asks for a different stack (Vue, Svelte, Preact, plain TypeScript without React, etc.), the same pattern applies: add a `content/package.json` with whatever bundler they prefer, output to `content/dist/`, and have `index.html` load the built artifact. The extension-side code does not change.

## The page-side `window.copilot` bridge

The bridge script (served at `/__bridge.js` automatically by the lib) injects:

```js
window.copilot = new Proxy({}, {
  get: (_, method) => async (...args) => { /* WS round-trip */ }
});
```

So **any** property access on `copilot` returns an async function. `await copilot.foo(1, 2)` sends `{ method: "foo", args: [1, 2] }` over the WebSocket and resolves with whatever the matching callback in `main.mjs` returns. Unknown methods reject with `unknown callback: foo`.

Args and return values are JSON-serialized. Non-serializable return values are coerced to `String(...)`.

`index.html` MUST include `<script src="/__bridge.js"></script>` in `<head>` (or otherwise before any code that uses `copilot`). The bridge buffers calls until the WebSocket opens, so it's safe to call `copilot.*` immediately on page load.

## Defining callbacks (what `main.mjs` is for)

In `main.mjs`, instantiate `CopilotWebview` once with your `extensionName`, `contentDir`, and `callbacks`. The slash command is defined inline alongside it so it's easy to customize:

```js
const webview = new CopilotWebview({
    extensionName: "myapp",
    contentDir: join(import.meta.dirname, "content"),
    callbacks: {
        log: (msg, opts) => session.log(msg, opts),
        getTodos: () => readTodosFromDb(...),
        approve: (id) => session.send({ prompt: `User approved ${id}` }),
        // ...add whatever the page needs
    },
    // Optional: title, width, height
});

const session = await joinSession({
    tools: webview.tools,
    commands: [{
        name: webview.extensionName,
        description: `Open the ${webview.extensionName} webview window.`,
        handler: async () => { await webview.show(); },
    }],
    hooks: { onSessionEnd: webview.close },
});
```

Each callback may be sync or async. Throw to surface an error to the page (the page-side promise rejects with the thrown message).

`webview.show()` is idempotent — calling it when the window is already open just returns the existing handle.

## Pushing data into the page

Use `webview.eval(...)` directly:

```js
await webview.eval(`window.updateChart(${JSON.stringify(data)})`);
```

The page can expose any function on `window` to receive pushes; there is no special protocol. The `<extensionName>_eval` tool is also auto-registered for the agent to use the same way.

## Do / don't

- **Do** copy `lib/` verbatim. **Don't** edit it (cross-platform behaviour and lifecycle handling are subtle).
- **Do** keep `extension.mjs` as a 3-line bootstrapper that calls `bootstrap()` then dynamic-imports `main.mjs`. **Don't** put static imports of npm deps in `extension.mjs` — they fail on a fresh clone before `npm install` runs.
- **Do** keep `<script src="/__bridge.js"></script>` first in your HTML.
- **Don't** try to `spawn()` the webview yourself or use Worker threads — native GUI must run on its own process's main thread, and the lib already handles that.
- **Don't** run `npm install` from inside the React content build automatically on every extension load. The user explicitly opted out of auto-build for `content/`.
- **Don't** assume Windows. The cleanup of `WEBVIEW2_USER_DATA_FOLDER` is Windows-only and gated inside the lib; macOS and Linux store webview data in shared platform locations and don't need per-window cleanup. No conditional logic should leak into user code.

## Quick reference: the API surface user code touches

From `lib/copilot-webview.js`:

| Export | Purpose |
|---|---|
| `bootstrap(extDir)` | Install deps if needed. Call once from `extension.mjs`. |
| `class CopilotWebview` | One instance per extension. Constructor takes `{ extensionName, contentDir, callbacks?, title?, width?, height? }`. |

Instance members:

| Member | Purpose |
|---|---|
| `.tools` | Array of tool defs (`<extensionName>_show`/`_eval`/`_close`). Spread into `joinSession({ tools })`. |
| `.show()` | Open the window (idempotent). Returns the window handle. |
| `.eval(code, opts?)` | Run JS in the page; rejects if not open. |
| `.close()` | Close the window if open. Pre-bound — pass directly as `hooks.onSessionEnd`. |
| `.extensionName` | The configured extension name (handy for the slash command's `name` field). |

Wired up in `main.mjs`:

- Slash command `/<extensionName>` — defined inline in main.mjs; calls `webview.show()`. Customize the handler freely.
- Tool `<extensionName>_show()` → opens the window
- Tool `<extensionName>_eval({ code, timeout? })` → result of last expression
- Tool `<extensionName>_close()` → closes the window

## Files in this skill

- `template/` — recursively copy this whole directory into the target extension directory.
  - `template/lib/copilot-webview.js`, `template/lib/webview-child.mjs` — the reusable library. **Verbatim.**
  - `template/extension.mjs`, `template/main.mjs`, `template/package.json`, `template/.gitignore` — extension scaffolding. Customize `main.mjs`.
  - `template/content/` — minimal vanilla HTML/JS page; the default starting point.
- `content-examples/` — alternative content stacks. Use one of these to replace `<target>/content/` if vanilla isn't the right fit.
  - `content-examples/react/` — React+TSX page with esbuild build.
