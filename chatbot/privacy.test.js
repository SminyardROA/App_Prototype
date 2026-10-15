import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { app, chatFailureMessage } from "./server.js";
import { containsObviousPersonalData } from "./personal-data.js";

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

test("billing failures explain the outage without exposing provider error details", () => {
  const providerMessage = "Your credit balance is too low. Private request details must not appear.";
  const message = chatFailureMessage({
    status: 400,
    error: { type: "error", error: { type: "invalid_request_error", message: providerMessage } },
  });
  assert.match(message, /billing attention/);
  assert.doesNotMatch(message, /Private request|credit balance/);
  assert.equal(chatFailureMessage({ status: 500, message: "request data" }),
    "Something went wrong. Please try again.");
});

test("serves only the explicitly allowlisted public chatbot assets", async () => {
  for (const asset of ["/", "/testpage.html", "/widget-preview.html", "/widget.js", "/logo.png", "/reserveconnect-ai-explorer-logo.png", "/lawcenter.webp"]) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
  }
  const preview = await (await fetch(`${base}/widget-preview.html`)).text();
  assert.match(preview, /<script src="\/widget\.js"><\/script>/);
});

test("does not serve member data or project files", async () => {
  for (const privatePath of [
    "/emails.txt",
    "/config.js",
    "/config.js.backup-20260921",
    "/server.js",
    "/testpage.html.backup-20260921",
    "/package.json",
    "/.git/config",
    "/../server.js",
    "/%2e%2e/server.js",
    "/widget.js.map",
    "/ingest-progress.json",
    "/beta-test-100-report.json",
  ]) {
    const response = await fetch(`${base}${privatePath}`);
    assert.equal(response.status, 404, privatePath);
  }
});

test("preview test page can make same-origin API requests without allowing arbitrary origins", async () => {
  const origin = base;
  const response = await fetch(`${base}/chat`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const page = await (await fetch(`${base}/testpage.html`)).text();
  assert.match(page, /id="clear-chat"/);
  assert.doesNotMatch(page, /id="email-gate"/);
  assert.match(page, /Stay connected with ROA\?/);
});

test("chat responses cannot be cached, and signup storage is disabled", async () => {
  const response = await fetch(`${base}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "" }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  for (const method of ["POST", "GET", "OPTIONS"]) {
    const signup = await fetch(`${base}/save-email`, {
      method, ...(method === "POST" ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.invalid" }),
      } : {}),
    });
    assert.equal(signup.status, 404);
  }
});

test("identifiers that cannot be safely redacted are stopped before retrieval or model calls", async () => {
  const privateInputs = [
    "Use card 4111 1111 1111 1111",
    "My account number is ABCD987654321",
  ];
  for (const message of privateInputs) {
    assert.equal(containsObviousPersonalData(message), true, message);
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.43" },
      body: JSON.stringify({ message }),
    });
    assert.equal(response.status, 422, message);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.doesNotMatch(JSON.stringify(await response.json()), /4111|ABCD987654321/);
  }
  const historyResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.43" },
    body: JSON.stringify({
      message: "What does USERRA cover?",
      conversationHistory: [{ role: "user", content: "My account number is ABCD987654321" }],
    }),
  });
  assert.equal(historyResponse.status, 422);
  for (const safe of ["What does 50 USC 3955 say?", "What is the BAH rate for an E-5?", "Call a JAG attorney."]) {
    assert.equal(containsObviousPersonalData(safe), false, safe);
  }
});

test("both chat clients clear conversations and ignore responses from a closed chat", () => {
  const page = fs.readFileSync(new URL("./testpage.html", import.meta.url), "utf8");
  const widget = fs.readFileSync(new URL("../widget.js", import.meta.url), "utf8");
  for (const source of [page, widget]) {
    assert.match(source, /Closing chat clears this conversation from this page/);
    assert.match(source, /Questions are processed by AI service providers to generate answers/);
    assert.match(source, /hosting logs still need to be verified/);
    assert.match(source, /does not use live web search/);
    assert.doesNotMatch(source, /zero retention|fully private/i);
    assert.match(source, /function resetConversation\(\)/);
    assert.match(source, /activeRequest\?\.abort\(\)/);
    assert.match(source, /currentRequest !== requestId/);
    assert.doesNotMatch(source, /We don't store your chat conversations/);
  }
});

test("closing the standalone chat discards a pending answer and starts fresh on reopen",
  { skip: spawnSync("which", ["chromium"]).status !== 0 }, () => {
    const page = fs.readFileSync(new URL("./testpage.html", import.meta.url), "utf8");
    const script = `<script>
      window.fetch = () => new Promise(resolve => {
        window.releaseChat = () => resolve({ok:true,body:{getReader(){
          return {async read(){return {done:true}}};
        }}});
      });
    </script>`;
    const testScript = `<script>
      (async () => {
        const field = document.getElementById("input");
        field.value = "PRIVATE TEST DETAILS";
        document.getElementById("send-btn").click();
        document.getElementById("close-chat").click();
        const cleared = !document.getElementById("chat").textContent.includes("PRIVATE TEST DETAILS");
        window.releaseChat();
        await new Promise(resolve => setTimeout(resolve, 100));
        document.getElementById("open-chat").click();
        const fresh = !document.getElementById("chat").textContent.includes("PRIVATE TEST DETAILS")
          && document.getElementById("chat").textContent.includes("Hello.");
        window.fetch = async () => ({ok:false,status:422});
        field.value = "member@example.org";
        document.getElementById("send-btn").click();
        await new Promise(resolve => setTimeout(resolve, 100));
        const protectedInput = !document.getElementById("chat").textContent.includes("member@example.org")
          && document.getElementById("chat").textContent.includes("remove email addresses");
        document.body.insertAdjacentHTML("beforeend",
          '<pre id="privacy-result">' + (cleared && fresh && protectedInput ? "PASS" : "FAIL") + '</pre>');
      })();
    </script>`;
    const html = page.replace("<script>\n    const BACKEND", `${script}<script>\n    const BACKEND`)
      .replace("</body>", `${testScript}</body>`)
      .replace(/@import url\([^;]+;/, "");
    const result = spawnSync("chromium", [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
      "--virtual-time-budget=2000", "--dump-dom",
      `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 3 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.slice(-1200));
    assert.match(result.stdout, /<pre id="privacy-result">PASS<\/pre>/);
  });

test("completed replies in both chat clients return to the start of the answer", () => {
  const page = fs.readFileSync(new URL("./testpage.html", import.meta.url), "utf8");
  const widget = fs.readFileSync(new URL("../widget.js", import.meta.url), "utf8");
  for (const [source, variable] of [[page, "botMessage"], [widget, "botMsg"]]) {
    assert.match(source, /function scrollToAnswerStart\(answer\)/);
    assert.match(source, /answer\.getBoundingClientRect\(\)\.top/);
    assert.match(source, new RegExp(`offerSignup\\(\\);[\\s\\S]{0,100}scrollToAnswerStart\\(${variable}\\)`));
  }
});

test("accepts the preview proxy's stripped Host port, but not a different port", async () => {
  const port = server.address().port;
  for (const pathname of ["/chat"]) {
    const allowed = await fetch(`${base}${pathname}`, {
      method: "OPTIONS",
      headers: { Host: "127.0.0.1", Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), `http://127.0.0.1:${port}`);

    const denied = await fetch(`${base}${pathname}`, {
      method: "OPTIONS",
      headers: { Host: "127.0.0.1", Origin: `http://127.0.0.1:${port + 1}` },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
});

test("blocks ROA public-site browser origins including preflight requests", async () => {
  for (const origin of ["https://roa.org", "https://www.roa.org"]) {
    for (const method of ["OPTIONS", "POST"]) {
      const response = await fetch(`${base}/chat`, {
        method, headers: { Origin: origin, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ message: "hello" }) } : {}),
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  }
  for (const origin of ["https://evil.example", "https://roa.org.evil.example", "http://roa.org", "null"]) {
    for (const method of ["OPTIONS", "POST"]) {
      const response = await fetch(`${base}/chat`, {
        method, headers: { Origin: origin, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ message: "hello" }) } : {}),
      });
      assert.equal(response.status, 403, `${method} ${origin}`);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  }
});

test("fairly limits chat using only transient in-memory IP keys", async () => {
  const code = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.match(code, /const key = req\.ip/);
  assert.match(code, /app\.post\("\/chat", limitRequests\(30,/);
  assert.doesNotMatch(code, /new pg\.Pool/);
  const response = await fetch(`${base}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.99" },
    body: JSON.stringify({ message: "test", chatMode: "invalid" }),
  });
  assert.equal(response.status, 400);
});

test("live model request has no web-search tool", () => {
  const code = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.match(code, /anthropic\.messages\.stream\(\{/);
  assert.doesNotMatch(code, /web_search_\d+|tools:\s*\[/);
});

test("rejects malformed JSON without echoing its contents", async () => {
  const response = await fetch(`${base}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: '{"message":"private@example.com",',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid request body" });
});

test("both chat clients offer three direct links once after four answers without collecting signup details", () => {
  const sources = [
    fs.readFileSync(new URL("../widget.js", import.meta.url), "utf8"),
    fs.readFileSync(new URL("./testpage.html", import.meta.url), "utf8"),
  ];
  for (const source of sources) {
    assert.match(source, /signupProgress\.answers < 4/);
    assert.match(source, /signupProgress\.shown = true/);
    assert.match(source, /sessionStorage\.setItem\(signupKey, JSON\.stringify\(signupProgress\)\)/);
    assert.match(source, /https:\/\/newsletter\.smartbrief\.com\/rest\/sign-up\/36B2225B-FD16-44ED-87FF-31158956003F/);
    assert.match(source, /https:\/\/roa\.org\/roaemail\//);
    assert.match(source, /href="https:\/\/roa\.org"/);
    assert.match(source, /currently serving and under 35, membership is free; if you're over 35, it's \$20\/year/);
    assert.match(source, /No thanks — keep chatting/);
    assert.doesNotMatch(source, /name="smartbriefOptIn"|\/save-email/);
    assert.match(source, /conversationState = \{\};/);
    assert.doesNotMatch(source, /localStorage\.setItem/);
  }
});

test("fourth completed answer shows the invitation; declining allows another question without a repeat",
  { skip: spawnSync("which", ["chromium"]).status !== 0 }, () => {
    const page = fs.readFileSync(new URL("./testpage.html", import.meta.url), "utf8");
    const mock = `<script>
      window.fetch = async () => ({
        ok: true,
        body: {getReader() {
          let sent = false;
          return {async read() {
            if (sent) return {done: true};
            sent = true;
            const payload = 'data: {"type":"text","text":"Answer."}\\\\n\\\\n'
              + 'data: {"type":"done","finalText":"Answer."}\\\\n\\\\n';
            return {done: false, value: new TextEncoder().encode(payload.replaceAll('\\\\n', '\\n'))};
          }};
        }}
      });
    </script>`;
    const check = `<script>
      (async () => {
        const field = document.getElementById("input");
        const chat = document.getElementById("chat");
        async function ask() {
          field.value = "Question";
          document.getElementById("send-btn").click();
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        for (let i = 0; i < 3; i++) await ask();
        const early = !document.getElementById("optional-signup");
        await ask();
        const invitation = document.getElementById("optional-signup");
        const links = [...(invitation?.querySelectorAll("a") || [])].map(a => a.href);
        const valid = links.length === 3
          && links[0] === "https://newsletter.smartbrief.com/rest/sign-up/36B2225B-FD16-44ED-87FF-31158956003F"
          && links[1] === "https://roa.org/roaemail/"
          && links[2] === "https://roa.org/"
          && [...invitation.querySelectorAll("a")].every(a => a.target === "_blank" && a.rel.includes("noopener"))
          && !invitation.querySelector("form");
        invitation.querySelector("button").click();
        const declined = !document.getElementById("optional-signup");
        await ask();
        const continues = !document.getElementById("optional-signup") && chat.textContent.includes("Answer.");
        document.body.insertAdjacentHTML("beforeend",
          '<pre id="invitation-result">' + (early && valid && declined && continues ? "PASS" : "FAIL") + '</pre>');
      })();
    </script>`;
    const html = page.replace("<script>\n    const BACKEND", `${mock}<script>\n    const BACKEND`)
      .replace("</body>", `${check}</body>`)
      .replace(/@import url\([^;]+;/, "");
    const result = spawnSync("chromium", [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
      "--virtual-time-budget=4000", "--dump-dom",
      `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 3 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.slice(-1200));
    assert.match(result.stdout, /<pre id="invitation-result">PASS<\/pre>/);
  });

test("old signup configuration cannot reactivate personal-data storage", async () => {
  const response = await fetch(`${base}/save-email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "member@example.invalid" }),
  });
  assert.equal(response.status, 404);
  assert.equal(fs.existsSync(new URL("./member-signups.sql", import.meta.url)), false);
});