import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const chromium = spawnSync("which", ["chromium"], { encoding: "utf8" }).status === 0;
const widget = fs.readFileSync(new URL("../widget.js", import.meta.url), "utf8")
  .replace(/@import url\([^;]+;/, "");
const standalone = fs.readFileSync(new URL("./testpage.html", import.meta.url), "utf8")
  .replace(/@import url\([^;]+;/, "");

function checkPage(html, script, maxWidth, size, keyboard) {
  const probe = `<script>(function () {
    ${script}
    const panel = document.querySelector(".rc-widget, #roa-chat-window");
    const composer = document.querySelector(".rc-composer, #roa-input-area");
    const mode = document.querySelector(".rc-modebar, #roa-mode-area");
    const source = document.querySelector(".rc-source, .roa-sources a");
    const disclaimer = document.querySelector(".rc-disclaimer, #roa-disclaimer");
    const view = window.visualViewport;
    const bounds = panel.getBoundingClientRect();
    const privacy = document.querySelector(".rc-privacy-note, #roa-privacy-details");
    // The short panel is allowed to scroll vertically, but no controls or
    // unbroken source links should force sideways scrolling.
    const checks = {
      viewport: [innerWidth, innerHeight, view?.height],
      panelFitsWidth: bounds.left >= -1 && bounds.right <= innerWidth + 1,
      noHorizontalScroll: document.documentElement.scrollWidth <= innerWidth + 1 &&
        panel.scrollWidth <= panel.clientWidth + 1,
      scrollToComposer: (panel.scrollTop = panel.scrollHeight),
      composerReachable: composer.getBoundingClientRect().bottom <= bounds.bottom + 1,
      noSearchModeControls: mode === null,
      sourceWraps: source.scrollWidth <= source.clientWidth + 1,
      sourceReadable: parseFloat(getComputedStyle(source).fontSize) >= 14,
      disclaimerReadable: parseFloat(getComputedStyle(disclaimer).fontSize) >= 14,
    };
    const widgetWindow = document.getElementById("roa-chat-window");
    if (widgetWindow) {
      checks.disclosureHalfHeight = document.getElementById("roa-ai-notice")
        .getBoundingClientRect().height <= 100;
      checks.disclosureScrolls = document.getElementById("roa-ai-notice").scrollHeight >
        document.getElementById("roa-ai-notice").clientHeight;
      if (innerHeight >= 640) checks.answerAreaExpanded =
        document.getElementById("roa-messages").getBoundingClientRect().height >=
        (innerWidth >= 900 ? (innerHeight >= 850 ? 450 : 300) : 200);
      if (innerHeight >= 640) {
        const readAnswer = document.getElementById("roa-read-answer");
        readAnswer.hidden = false;
        checks.answerAreaWithReplyControls =
          document.getElementById("roa-messages").getBoundingClientRect().height >=
          (innerWidth >= 900 ? (innerHeight >= 850 ? 400 : 260) : 160);
        readAnswer.hidden = true;
      }
    }
    if (${keyboard}) {
      // Simulate a keyboard reducing the visual viewport without resizing the
      // layout viewport; CSS vh alone does not handle this on every browser.
      Object.defineProperty(view, "height", { configurable: true, value: 180 });
      view.dispatchEvent(new Event("resize"));
      checks.keyboardHeight = Math.abs(panel.getBoundingClientRect().height - 180) < 1;
      panel.scrollTop = panel.scrollHeight;
      checks.keyboardComposerReachable =
        composer.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1;
    }
    privacy.open = true;
    checks.expandedPrivacyFits = privacy.scrollWidth <= privacy.clientWidth + 1 &&
      panel.scrollWidth <= panel.clientWidth + 1;
    if (widgetWindow) {
      checks.privacyDetailsScrollable = privacy.querySelector("p").scrollHeight >
        privacy.querySelector("p").clientHeight;
      checks.privacyCloseShown = getComputedStyle(
        privacy.querySelector(".roa-privacy-action-close")).display !== "none";
      if (innerHeight >= 640) checks.privacyLeavesAnswerSpace =
        document.getElementById("roa-messages").getBoundingClientRect().height >=
        (innerWidth >= 900 ? 240 : 200);
      privacy.querySelector("summary").click();
      checks.privacyCloses = !privacy.open &&
        getComputedStyle(privacy.querySelector(".roa-privacy-action-open")).display !== "none";
    }
    window.parent.postMessage(JSON.stringify(checks), "*");
  })();</script>`;
  const page = html.replace("</body>", `${probe}</body>`);
  const [width, height] = size.split(",").map(Number);
  const nested = `data:text/html;base64,${Buffer.from(page).toString("base64")}`;
  const wrapper = `<!doctype html><html><body style="margin:0"><iframe src="${nested}"
    style="width:${width}px;height:${height}px;border:0"></iframe>
    <script>window.addEventListener("message", event => {
      document.body.insertAdjacentHTML("beforeend",
        '<pre id="reflow-result">' + event.data + '</pre>');
    });</script></body></html>`;
  const url = `data:text/html;base64,${Buffer.from(wrapper).toString("base64")}`;
  const result = spawnSync("chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    "--window-size=900,1000",
    "--virtual-time-budget=1500", "--dump-dom", url,
  ], { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.slice(-1200));
  const match = [...result.stdout.matchAll(/<pre id="reflow-result">([^<]+)<\/pre>/g)].at(-1);
  assert.ok(match && match[1].startsWith("{"), result.stdout.slice(-1500));
  const checks = JSON.parse(match[1].replaceAll("&quot;", '"'));
  assert.ok(checks.viewport[0] <= maxWidth,
    `Expected CSS viewport at most ${maxWidth}px, got ${checks.viewport}`);
  for (const [name, value] of Object.entries(checks)) {
    if (name !== "viewport" && name !== "scrollToComposer") {
      assert.equal(value, true, `${name} failed at ${checks.viewport} (${size})`);
    }
  }
}

function checkStandaloneGeometry(width, height) {
  const probe = `<script>(function () {
    const panel = document.querySelector(".rc-widget");
    const messages = document.querySelector(".rc-messages");
    const modebar = document.querySelector(".rc-modebar");
    const checks = {
      noSearchModeControls: modebar === null && !document.querySelector(".rc-mode-option"),
      answerSpace: messages.getBoundingClientRect().height >=
        (innerWidth >= 900 ? 480 : 360),
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1 &&
        panel.scrollWidth <= panel.clientWidth + 1,
      composerVisible: document.querySelector(".rc-composer").getBoundingClientRect().height >= 44,
    };
    window.parent.postMessage(JSON.stringify(checks), "*");
  })();</script>`;
  const page = standalone.replace("</body>", `${probe}</body>`);
  const nested = `data:text/html;base64,${Buffer.from(page).toString("base64")}`;
  const wrapper = `<!doctype html><html><body style="margin:0"><iframe src="${nested}"
    style="width:${width}px;height:${height}px;border:0"></iframe>
    <script>window.addEventListener("message", event => {
      document.body.insertAdjacentHTML("beforeend",
        '<pre id="geometry-result">' + event.data + '</pre>');
    });</script></body></html>`;
  const url = `data:text/html;base64,${Buffer.from(wrapper).toString("base64")}`;
  const result = spawnSync("chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    "--window-size=1400,1100", "--virtual-time-budget=1500", "--dump-dom", url,
  ], { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.slice(-1200));
  const match = [...result.stdout.matchAll(/<pre id="geometry-result">([^<]+)<\/pre>/g)].at(-1);
  assert.ok(match, result.stdout.slice(-1500));
  const checks = JSON.parse(match[1].replaceAll("&quot;", '"'));
  for (const [name, value] of Object.entries(checks)) {
    assert.equal(value, true, `${name} failed at ${width}×${height}`);
  }
}

for (const [label, width, height] of [
  ["minimum ordinary phone width", 320, 740],
  ["phone", 390, 844],
  ["desktop", 1280, 900],
]) {
  test(`standalone chat readability geometry at ${label}`, { skip: !chromium }, () => {
    checkStandaloneGeometry(width, height);
  });
}

test("small text and interactive red meet AA text contrast", () => {
  function luminance(hex) {
    const channels = hex.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16) / 255);
    return channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  }
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) /
    (Math.min(luminance(a), luminance(b)) + .05);
  for (const [foreground, background] of [
    ["#B61D30", "#ffffff"], ["#46576d", "#ffffff"],
    ["#01225E", "#ffffff"], ["#52657e", "#f3f6fa"],
  ]) assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background}`);
});

for (const [name, html, setup] of [
  ["embedded", `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
    <script>${widget.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
  `document.getElementById("roa-chat-bubble").click();
   const sources = document.createElement("div");
   sources.className = "roa-sources";
   sources.innerHTML = '<a href="https://example.org">https://example.org/' + 'long-segment-'.repeat(20) + '</a>';
   document.getElementById("roa-messages").appendChild(sources);`],
  ["standalone", standalone,
  `const sources = document.createElement("div");
   sources.className = "rc-sources";
   sources.innerHTML = '<a class="rc-source" href="https://example.org">https://example.org/' + 'long-segment-'.repeat(20) + '</a>';
   document.getElementById("chat").appendChild(sources);`],
]) {
  for (const [label, scale, size] of [
    ["desktop", 1280, "1280,900"],
    ["desktop, shorter viewport", 1280, "1280,720"],
    ["200% zoom equivalent (640 CSS px)", 640, "640,450"],
    ["400% zoom equivalent (320 CSS px)", 320, "320,225"],
    ["phone", 390, "390,844"],
    ["narrow", 360, "360,640"],
    ["just above single-row cutoff", 321, "321,844"],
    ["short / keyboard-sized", 360, "360,320"],
  ]) {
    test(`${name} reflows at ${label}`, { skip: !chromium }, () => {
      checkPage(html, setup, scale, size, label === "short / keyboard-sized");
    });
  }
}