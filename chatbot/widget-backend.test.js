import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const widget = fs.readFileSync(new URL("../widget.js", import.meta.url), "utf8");
const expression = widget.match(/backendUrl:\s*(.+),\n/)[1];

for (const [name, src, expected] of [
  ["Render", "https://roa-chatbot-backend.onrender.com/widget.js", "https://roa-chatbot-backend.onrender.com"],
  ["preview", "https://preview.replit.dev:5000/widget.js", "https://preview.replit.dev:5000"],
  ["inline fallback", "", "https://roa-chatbot-backend.onrender.com"],
]) {
  test(`widget selects its ${name} backend without a hard-coded development host`, () => {
    const result = vm.runInNewContext(expression, {
      URL, document: { currentScript: src ? { src } : null },
      window: { location: { href: "https://preview.replit.dev/widget-preview.html" } },
    });
    assert.equal(result, expected);
  });
}
