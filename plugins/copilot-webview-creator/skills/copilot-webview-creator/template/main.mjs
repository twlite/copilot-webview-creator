// Real extension entry. Customize the callbacks and the slash command for
// your own use case
import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { CopilotWebview } from "./lib/copilot-webview.js";

const webview = new CopilotWebview({
    extensionName: "my_dashboard", // Must be safe as JS identifier (is prefix to tool names), so don't use spaces or dashes
    contentDir: join(import.meta.dirname, "content"),
    callbacks: {
        // Page-side `copilot.<name>(...args)` calls land here. Each callback may
        // be async; its return value is sent back to the page.
        log: (msg, opts) => session.log(msg, opts),
    },
    // Optional window defaults: title, width, height
});

const session = await joinSession({
    tools: webview.tools,
    commands: [{
        // Customize freely — accept arguments, post a follow-up
        // prompt to the agent, etc. `webview.show()` is idempotent.
        name: "my-dashboard",
        description: `Open the webview window.`,
        handler: webview.show,
    }],
    hooks: { onSessionEnd: webview.close },
});
