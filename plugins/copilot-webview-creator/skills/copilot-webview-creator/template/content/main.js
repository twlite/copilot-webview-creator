// Page-side logic. `window.copilot` is provided by /__bridge.js.
const countEl = document.getElementById("count");
const btn = document.getElementById("btn");
let n = 0;

btn.addEventListener("click", async () => {
  n++;
  countEl.textContent = String(n);
  // Round-trips to the extension and resolves with whatever the callback
  // returns. Throws if the callback throws (or isn't registered).
  await copilot.log(`button clicked (count=${n})`);
});
