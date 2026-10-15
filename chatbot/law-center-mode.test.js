import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyQuery,
  ensureCompleteAnswer,
  getKnowledgeBaseContext,
  normalizeLawCenterName,
  trimToLastCompleteSentence,
} from "./server.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const widgetSource = fs.readFileSync(path.join(testDir, "..", "widget.js"), "utf8");
const testPageSource = fs.readFileSync(path.join(testDir, "testpage.html"), "utf8");
const serverSource = fs.readFileSync(path.join(testDir, "server.js"), "utf8");
const welcomeText = "Hello. I search the full ReserveConnect knowledge base, with a focus on VA disability claims and benefits. Disability answers require relevant source support. What can I help you research?";

test("welcome describes full retrieval and source-supported disability research", () => {
  assert.match(widgetSource, new RegExp(welcomeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(testPageSource, new RegExp(welcomeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Law Center banners use the replacement WebP logo", () => {
  assert.match(widgetSource, /lawcenter\.webp/);
  assert.match(testPageSource, /lawcenter\.webp/);
  assert.doesNotMatch(widgetSource, /lawcenter\.png/);
  assert.doesNotMatch(testPageSource, /lawcenter\.png/);
  for (const source of [widgetSource, testPageSource]) {
    assert.match(source, /width:\s*160px;\s*max-width:\s*100%;\s*height:\s*auto/);
  }
});

test("Law Center no-match responses link to the full navigator", () => {
  assert.match(serverSource, /\[Full ReserveConnect Navigator\]\(\/\)/);
  assert.match(serverSource, /couldn't find a matching article/i);
});

test("ReserveConnect branding uses the new organization name and explorer logo", () => {
  assert.doesNotMatch(testPageSource, /Reserve Officers Association/);
  assert.match(testPageSource, /Reserve Organization of America/);
  assert.doesNotMatch(testPageSource, /rc-gate-mark"[^>]*>R</);
  assert.match(testPageSource, /reserveconnect-ai-explorer-logo\.png/);
  assert.match(widgetSource, /id="roa-header-logo"/);
  assert.match(widgetSource, /background: white;[\s\S]*color: \$\{CONFIG\.primaryColor\}/);
  for (const color of ["#01225E", "#849CC1", "#B61D30"]) {
    assert.match(widgetSource, new RegExp(color, "i"));
    assert.match(testPageSource, new RegExp(color, "i"));
  }
  assert.doesNotMatch(widgetSource, /#98182a|#17253a/i);
  assert.doesNotMatch(testPageSource, /#98182a|#17253a/i);
});

test("non-legal questions can still be identified without blocking Law Center search", () => {
  assert.equal(classifyQuery("How much BAH will I receive?").legal, false);
  assert.equal(classifyQuery("What does USERRA require?").legal, true);
});

test("mobilization lease cancellation stays in Law Center scope without naming SCRA", () => {
  for (const question of [
    "I just go mob orders and need to cancel my lease",
    "I got mobilization orders. Can I break my apartment lease?",
    "Can I terminate my rental agreement due to military orders?",
  ]) {
    assert.equal(classifyQuery(question).key, "legal", question);
  }
  assert.equal(classifyQuery("How much BAH covers my lease?").key, "pay");
});

test("Law Center lease questions focus retrieval on SCRA and keep article sources", async () => {
  const url = "https://roa.org/wp-content/uploads/2025/12/23033-LR.pdf";
  let expandedQuery;
  let queryCount = 0;
  const result = await getKnowledgeBaseContext(
    "I just go mob orders and need to cancel my lease",
    {
      chatMode: "law_center",
      retrievalClient: {
        indexHost: "mock.test",
        embed: async query => { expandedQuery = query; return [0.1]; },
        fetch: async () => {
          queryCount += 1;
          return { ok: true, json: async () => ({ matches: [{
            id: "scra-lease-article", score: 0.9,
            metadata: {
              url, title: "SCRA Lease Termination",
              text: "The SCRA governs termination of residential leases on qualifying military orders.",
            },
          }] }) };
        },
      },
    }
  );
  assert.match(expandedQuery, /SCRA.*residential lease termination.*50 USC 3955/);
  assert.equal(queryCount, 1);
  assert.equal(result.retrieval.lawCenterOnly, true);
  assert.ok(result.sources.includes(url));
});

test("regular mode searches Law Center articles even without legal keywords", async () => {
  const url = "https://roa.org/wp-content/uploads/2025/12/23033-LR.pdf";
  const queries = [];
  const result = await getKnowledgeBaseContext("My landlord wants me out", {
    retrievalClient: {
      indexHost: "mock.test",
      embed: async () => [0.1],
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        queries.push(body);
        const article = Boolean(body.filter);
        return { ok: true, json: async () => ({ matches: [{
          id: article ? "article" : "general",
          score: article ? 0.88 : 0.76,
          metadata: article
            ? { url, title: "SCRA Residential Lease Rights", text: "SCRA residential lease termination protects some military members." }
            : { url: "https://example.org/general", title: "General information", text: "Other military information." },
        }] }) };
      },
    },
  });
  assert.equal(classifyQuery("My landlord wants me out").legal, false);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].filter, { type: { $eq: "law-center-pdf" } });
  assert.ok(result.sources.includes(url));
});

test("trims a token-limited answer to its last complete sentence", () => {
  const answer = "USERRA protects eligible service members. It also prohibits";
  assert.equal(
    trimToLastCompleteSentence(answer),
    "USERRA protects eligible service members."
  );
});

test("preserves a complete answer", () => {
  const answer = "USERRA protects eligible service members. Verify the facts with counsel.";
  assert.equal(trimToLastCompleteSentence(answer), answer);
});

test("returns a complete fallback when no sentence finished", () => {
  assert.equal(
    trimToLastCompleteSentence("USERRA protects eligible"),
    "The available Reserve Service Law Center articles require a narrower follow-up question for a complete answer."
  );
});

test("does not treat U.S. as a completed sentence", () => {
  assert.equal(
    trimToLastCompleteSentence("Under U.S. military law, an employer must"),
    "The available Reserve Service Law Center articles require a narrower follow-up question for a complete answer."
  );
});

test("does not treat U.S.C. as a completed sentence", () => {
  assert.equal(
    trimToLastCompleteSentence("Under 38 U.S.C. section 4301, an employer must"),
    "The available Reserve Service Law Center articles require a narrower follow-up question for a complete answer."
  );
});

test("finalizes every response at a complete sentence", () => {
  assert.equal(
    ensureCompleteAnswer("The first point is complete. The next point is unfinished"),
    "The first point is complete."
  );
});

test("preserves the Reserve Service Law Center banner after finalization", () => {
  assert.equal(
    ensureCompleteAnswer("The first point is complete. Unfinished tail\n\n[LAW_CENTER_BANNER]"),
    "The first point is complete.\n\n[LAW_CENTER_BANNER]"
  );
});

test("preserves Markdown layout when removing an unfinished tail", () => {
  assert.equal(
    ensureCompleteAnswer("First point.\n\n1. Second point.\n2. Unfinished"),
    "First point.\n\n1. Second point."
  );
});

test("normalizes former and shortened law center references", () => {
  assert.equal(
    normalizeLawCenterName(
      "The Service Members Law Center became the Law Center resource."
    ),
    "The Reserve Service Law Center became the Reserve Service Law Center resource."
  );
});

test("preserves multiple-choice options while ending cleanly", () => {
  assert.equal(
    ensureCompleteAnswer("Do you know what this is?\n\nA) Yes\nB) No"),
    "Do you know what this is?\n\nA) Yes.\nB) No."
  );
});

test("keeps a complete legal sentence before unfinished text", () => {
  assert.equal(
    trimToLastCompleteSentence("Under 38 U.S.C. section 4301, USERRA applies. An employer must"),
    "Under 38 U.S.C. section 4301, USERRA applies."
  );
});