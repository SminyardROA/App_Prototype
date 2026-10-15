import test from "node:test";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
installFixtureVaReviewer();
import assert from "node:assert/strict";
import { buildRetrievalQuery } from "./retrieval-query.js";
import { getKnowledgeBaseContext, app } from "./server.js";
import Anthropic from "@anthropic-ai/sdk";

test("full question uses its own wording, not a transcript", () => {
  const query = buildRetrievalQuery(
    "How does a National Guard member qualify for education benefits after activation?",
    [{ role: "user", content: "Unrelated employer issue" },
      { role: "assistant", content: "An older explanation about a different topic." }],
  );
  assert.match(query, /^How does a National Guard member qualify/);
  assert.doesNotMatch(query, /Unrelated employer issue|older explanation/);
});

test("short follow-up uses only the most recent user turn and a short reply excerpt", () => {
  const query = buildRetrievalQuery("What about that?", [
    { role: "user", content: "Do I qualify for a GI Bill?" },
    { role: "assistant", content: "Old assistant answer." },
    { role: "user", content: "What does TRICARE cover on mobilization?" },
    { role: "assistant", content: "x".repeat(500) },
  ]);
  assert.match(query, /Previous user question: What does TRICARE cover/);
  assert.doesNotMatch(query, /GI Bill|Old assistant/);
  assert.match(query, /Previous reply \(excerpt\): x{300}(?:\n|$)/);
});

test("selected option and known pay facts remain compact", () => {
  const query = buildRetrievalQuery("No dependents (option B)", [
    { role: "user", content: "I am E-5 on Title 10 orders." },
    { role: "assistant", content: "Do you have any dependents?" },
  ], { serviceYears: 7, payTraining: { type: "ADT" } }, { includePayFacts: true });
  assert.match(query, /^No dependents \(option B\)/);
  assert.match(query, /grade E-5; 7 years of service; orders ADT; orders Title 10/);
  assert.doesNotMatch(buildRetrievalQuery("Different question?", [], null, { offPathway: true }),
    /Previous|Known pay facts/);
});

test("no match and search failure have different results without leaking provider errors", async () => {
  const client = fetchImpl => ({
    indexHost: "fixture.invalid", embed: async text => text, fetch: fetchImpl,
  });
  const empty = await getKnowledgeBaseContext("An unsupported topic", {
    retrievalClient: client(async () => ({ ok: true, json: async () => ({ matches: [] }) })),
  });
  assert.equal(empty.status, "no_match");
  const blank = await getKnowledgeBaseContext("A source with no actual passage", {
    retrievalClient: client(async () => ({
      ok: true,
      json: async () => ({ matches: [{
        id: "blank", score: 0.9, metadata: { url: "https://roa.org/blank", text: "" },
      }] }),
    })),
  });
  assert.equal(blank.status, "no_match");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const error = await getKnowledgeBaseContext("PRIVATE QUESTION CONTENT", {
      retrievalClient: client(async () => { throw new Error("PRIVATE QUESTION CONTENT"); }),
    });
    assert.equal(error.status, "unavailable");
    assert.doesNotMatch(warnings.join(" "), /PRIVATE QUESTION CONTENT/);
  } finally {
    console.warn = originalWarn;
  }
});

test("chat skips the model on retrieval failure but instructs it carefully on no match", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const systems = [];
  Anthropic.Messages.prototype.stream = function ({ system, model, thinking }) {
    assert.equal(model, "claude-sonnet-5");
    assert.deepEqual(thinking, { type: "disabled" });
    systems.push(system);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta",
          text: "I couldn't find a verified ROA source. General, unverified orientation: contact VA and rephrase your question." } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      },
    };
  };
  const server = app.listen(0);
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "How do I qualify for an unknown benefit?", chatMode: "benefits" }),
    });
    return (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).at(-1);
  };
  try {
    app.locals.retrievalClient = {
      indexHost: "fixture.invalid", embed: async () => [0.1],
      fetch: async () => ({ ok: true, json: async () => ({ matches: [] }) }),
    };
    const noMatch = await send();
    assert.equal(noMatch.type, "done");
    assert.match(noMatch.finalText, /couldn't find a verified ROA source/);
    assert.equal(systems[0][0].cache_control.type, "ephemeral");
    assert.doesNotMatch(systems[0][0].text, /NO KNOWLEDGE-BASE MATCH/);
    assert.match(systems[0][1].text, /NO KNOWLEDGE-BASE MATCH/);
    assert.match(systems[0][1].text, /statute or regulation section numbers/);
    app.locals.retrievalClient = {
      indexHost: "fixture.invalid", embed: async () => { throw new Error("Private message"); },
    };
    const failure = await send();
    assert.equal(failure.retrieval.status, "unavailable");
    assert.match(failure.finalText, /temporarily unavailable/);
    assert.equal(systems.length, 1, "retrieval failure must not call the model");
  } finally {
    delete app.locals.retrievalClient;
    Anthropic.Messages.prototype.stream = originalStream;
    await new Promise(resolve => server.close(resolve));
  }
});