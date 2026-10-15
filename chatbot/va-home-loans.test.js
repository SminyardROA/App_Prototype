import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { fixtureVaReview } from "./va-review-fixture.js";
import { app } from "./server.js";
import {
  isVaHomeLoanServiceQuestion, vaHomeLoanServiceAnswer, VA_LOAN_SOURCES,
} from "./va-home-loans.js";

test("recognizes VA home-loan service eligibility without capturing unrelated loans", () => {
  assert.equal(isVaHomeLoanServiceQuestion("Do I qualify for a VA loan?"), true);
  assert.equal(isVaHomeLoanServiceQuestion("Am I eligible for a VA home loan as a Grey Area retiree?"), true);
  assert.equal(isVaHomeLoanServiceQuestion("Can I terminate my apartment lease under the SCRA?"), false);
  assert.equal(isVaHomeLoanServiceQuestion("What are the VA disability rating rules?"), false);
});

test("the official answer distinguishes Guard, Selected Reserve, and COE verification", () => {
  const text = vaHomeLoanServiceAnswer("Do I qualify for a VA loan?", [
    { role: "user", content: "I am a Grey Area retiree with 20 years of Guard service." },
  ]);
  assert.match(text, /Grey Area retiree/);
  assert.match(text, /6 creditable years/);
  assert.match(text, /30 consecutive days/);
  assert.match(text, /non-training/);
  assert.match(text, /Selected Reserve/);
  assert.doesNotMatch(text, /181 consecutive days|90 consecutive days during wartime|90 days of cumulative active duty under Title 10/);
  for (const url of VA_LOAN_SOURCES) assert.ok(text.includes(`](${url})`));
});

test("home-loan chat uses retrieved evidence and audits before displaying eligibility rules", async () => {
  const originalCreate = Anthropic.Messages.prototype.create;
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  const url = VA_LOAN_SOURCES[0];
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid", embed: async text => text,
    fetch: async () => ({ ok: true, json: async () => ({
      matches: [{ id: "loan", score: 0.99, metadata: { url, title: "VA home loan",
        text: "VA home loan eligibility depends on creditable service. A COE confirms eligibility." } }],
    }) }),
  };
  Anthropic.Messages.prototype.create = async params => fixtureVaReview(params);
  Anthropic.Messages.prototype.stream = () => ({ async *[Symbol.asyncIterator]() {
    yield { type: "content_block_delta", delta: { type: "text_delta",
      text: `A COE confirms home-loan eligibility [VA](${url}).` } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
  } });
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Do I qualify for a VA loan?",
        chatMode: "va",
        conversationHistory: [
          { role: "user", content: "I am a Grey Area retiree with 20 years of Guard service." },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.claimValidation, undefined);
    assert.deepEqual(done.sources, [url]);
    assert.match(done.finalText, /COE confirms/);
    assert.equal(events.filter(event => event.type === "text").length, 1);
    assert.equal(events.find(event => event.type === "text").text, done.finalText);
    assert.ok(done.conversationState);
  } finally {
    Anthropic.Messages.prototype.create = originalCreate;
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});