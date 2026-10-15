import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const widget = fs.readFileSync(new URL("../widget.js", import.meta.url), "utf8");

test("embedded widget exposes named controls and a completed-answer status", () => {
  assert.match(widget, /<button id="roa-chat-bubble"[^>]+aria-expanded="false"[^>]+aria-controls="roa-chat-window"/);
  assert.match(widget, /<label for="roa-input">Message<\/label>/);
  assert.match(widget, /<button id="roa-send-btn"[^>]+aria-label="Send message"/);
  assert.match(widget, /id="roa-status" role="status" aria-live="polite"/);
  assert.match(widget, /id="roa-read-answer"[^>]+hidden/);
  assert.match(widget, /closeChat\(\)[\s\S]*?bubble\.focus\(\)/);
  assert.match(widget, /activeRequest\?\.abort\(\)/);
  assert.match(widget, /currentRequest !== requestId/);
  assert.match(widget, /Closing chat clears this conversation from this page/);
});

const hasChromium = spawnSync("which", ["chromium"], { encoding: "utf8" }).status === 0;
test("embedded widget opens, announces the final reply, focuses it, and restores launcher focus",
  { skip: !hasChromium }, () => {
    // No model call or running server is needed. Only replace external resources.
    const source = widget
      .replace(/@import url\([^;]+;/, "")
      .replace(/backendUrl: "[^"]+"/, 'backendUrl: "http://127.0.0.1:9"');
    const page = `<!doctype html><html><body>
      <script>
        window.fetch = async () => {
          const events = [
            'data: {"type":"text","text":"Draft answer"}\\n',
            'data: ' + JSON.stringify({type:"done",finalText:"Final answer",
              sources:['https://example.com/?x=<img src=x onerror=alert(1)>', 'javascript:alert(1)']}) + '\\n'
          ];
          return { ok: true, body: { getReader() { return {
            async read() { return events.length
              ? { done: false, value: new TextEncoder().encode(events.shift()) }
              : { done: true }; }
          }; } } };
        };
      </script>
      <script>${source.replace(/<\/script/gi, "<\\/script")}</script>
      <script>
        (async () => {
          const bubble = document.getElementById("roa-chat-bubble");
          const input = document.getElementById("roa-input");
          const read = document.getElementById("roa-read-answer");
          const checks = [];
          checks.push(bubble.tagName === "BUTTON");
          bubble.click();
          checks.push(bubble.getAttribute("aria-expanded") === "true" && document.activeElement === input);
          input.value = "Test";
          document.getElementById("roa-send-btn").click();
          await new Promise(resolve => setTimeout(resolve, 100));
          checks.push(document.getElementById("roa-status").textContent.includes("Answer ready"));
          checks.push(!read.hidden);
          checks.push(document.querySelectorAll("#roa-messages .roa-sources a").length === 1);
          checks.push(document.querySelectorAll("#roa-messages img").length === 0);
          read.click();
          checks.push(document.activeElement.textContent.includes("Final answer"));
          input.focus();
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          checks.push(bubble.getAttribute("aria-expanded") === "false" && document.activeElement === bubble);
          checks.push(!document.getElementById("roa-messages").textContent.includes("Test"));
          checks.push(!document.getElementById("roa-messages").textContent.includes("Final answer"));
          bubble.click();
          checks.push(!document.getElementById("roa-messages").textContent.includes("Final answer"));
          const originalFetch = window.fetch;
          let releaseResponse;
          window.fetch = () => new Promise(resolve => {
            releaseResponse = () => originalFetch().then(resolve);
          });
          input.value = "PRIVATE TEXT";
          document.getElementById("roa-send-btn").click();
          document.getElementById("roa-close-btn").click();
          releaseResponse();
          await new Promise(resolve => setTimeout(resolve, 100));
          bubble.click();
          checks.push(!document.getElementById("roa-messages").textContent.includes("PRIVATE TEXT"));
          checks.push(!document.getElementById("roa-messages").textContent.includes("Final answer"));
          checks.push(read.hidden);
          window.fetch = async () => ({ ok: false, status: 422 });
          input.value = "member@example.org";
          document.getElementById("roa-send-btn").click();
          await new Promise(resolve => setTimeout(resolve, 100));
          checks.push(!document.querySelector("#roa-messages .roa-msg.user")?.textContent.includes("member@example.org"));
          checks.push(document.getElementById("roa-messages").textContent.includes("remove email addresses"));
          document.body.insertAdjacentHTML("beforeend",
            '<pre id="test-result">' + (checks.every(Boolean) ? "PASS" : "FAIL: " + checks.join(",")) + '</pre>');
        })();
      </script>
    </body></html>`;
    const url = `data:text/html;base64,${Buffer.from(page).toString("base64")}`;
    const result = spawnSync("chromium", [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
      "--virtual-time-budget=2000", "--dump-dom", url,
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 3 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.slice(-1200));
    assert.match(result.stdout, /<pre id="test-result">PASS<\/pre>/);
  });