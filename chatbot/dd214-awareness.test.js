import test from "node:test";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
installFixtureVaReviewer();
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { app } from "./server.js";
import { config } from "./config.js";
import { DD214_AWARENESS_QUESTION, resolveDd214State, removeRepeatedDd214Awareness } from "./dd214-awareness.js";

test("awareness survives a pause, legacy state, and history-only recovery", () => {
  for (const [state, legacy, history, expected] of [
    [{ dd214AwarenessAsked: true }, "not_started", [], "awareness_asked"],
    [{ dd214PathwayState: "completed" }, "not_started", [], "completed"],
    [{}, "review_offered", [], "review_offered"],
    [{}, "not_started", [{ role: "assistant", content: DD214_AWARENESS_QUESTION }], "awareness_asked"],
  ]) {
    assert.equal(resolveDd214State(state, legacy, history), expected);
    assert.equal(state.dd214AwarenessAsked, true);
  }
  const fresh = {};
  assert.equal(resolveDd214State(fresh, "not_started", [
    { role: "user", content: "Do you know what a DD214-1 is?" },
  ]), "not_started");
  assert.equal(fresh.dd214AwarenessAsked, false);
});

test("final guard removes repeated awareness but keeps DD214-1 explanations", () => {
  assert.equal(removeRepeatedDd214Awareness(`Your record matters.\n\n${DD214_AWARENESS_QUESTION}`), "Your record matters.");
  assert.equal(removeRepeatedDd214Awareness("Are you familiar with DD214-1?\n\nYou may request a records review."), "You may request a records review.");
  const answer = "DD Form 214-1 is the Reserve Component addendum. What is your records question?";
  assert.equal(removeRepeatedDd214Awareness(answer), answer);
});

test("Veteran instruction prefers Law Review 26074 without inventing citations", () => {
  assert.match(config.systemPrompt, /Law Review 26074 is the best reference for defining "Veteran"/);
  assert.match(config.systemPrompt, /Do not invent the article's contents, URL, or a citation if it was not retrieved/);
});

test("multi-turn chat asks awareness once across modes, topic changes, and resumed transition", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  let calls = 0;
  let systemText = "";
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid", embed: async () => [0.1],
    fetch: async () => ({ ok: true, json: async () => ({ matches: [{
      id: "fixture", score: 0.9, metadata: {
        title: "Member resources", text: "Reserve member resources.",
        url: "https://roa.org/member-resources",
      },
    }] }) }),
  };
  Anthropic.Messages.prototype.stream = params => {
    calls++;
    systemText = JSON.stringify(params.system);
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: {
        type: "text_delta", text: `Here are your resources.\n\n${DD214_AWARENESS_QUESTION}`,
      } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  const server = app.listen(0);
  let state = {};
  async function turn(message, chatMode = "general", extra = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, chatMode, conversationState: state, ...extra }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    const done = events.at(-1);
    assert.equal(done.type, "done");
    state = done.conversationState;
    return { done, emitted: events.filter(event => event.type === "text").map(event => event.text).join("") };
  }
  try {
    const first = await turn("I am separating.");
    assert.equal(first.done.finalText, DD214_AWARENESS_QUESTION);
    assert.equal(calls, 0, "awareness is deterministic, without a model call");
    assert.equal(state.dd214AwarenessAsked, true);
    const repeated = await turn("I am retiring.", "transition");
    assert.doesNotMatch(repeated.emitted, /do you know/i);
    const unrelated = await turn("What scholarships can I use?", "benefits");
    assert.doesNotMatch(unrelated.emitted, /do you know/i);
    assert.match(systemText, /AWARENESS ALREADY ASKED/);
    assert.equal(state.dd214AwarenessAsked, true);
    const yes = await turn("A", "transition");
    assert.equal(yes.done.dd214PathwayState, "completed");
    assert.match(yes.done.finalText, /roughly when/);
    await turn("I am not separating.");
    const resumed = await turn("I am separating.", "transition");
    assert.doesNotMatch(resumed.emitted, /do you know/i);
    assert.match(resumed.done.finalText, /roughly when/);
    // A new conversation is allowed its own first awareness question.
    state = {};
    assert.equal((await turn("I am retiring.")).done.finalText, DD214_AWARENESS_QUESTION);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
