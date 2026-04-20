import { useState } from "react";
import { createRoot } from "react-dom/client";

declare const copilot: { log: (msg: string, opts?: unknown) => Promise<void> };

function App() {
  const [n, setN] = useState(0);
  async function click() {
    const next = n + 1;
    setN(next);
    await copilot.log(`[react] button clicked (count=${next})`);
  }
  return (
    <main>
      <h1>👋 Hello from <code>copilot-webview</code> + React</h1>
      <p>Click count: <span id="count">{n}</span></p>
      <button onClick={click}>Click me</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
