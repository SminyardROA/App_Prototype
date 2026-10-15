import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { fixtureVaReview } from "./va-review-fixture.js";
import { app, getKnowledgeBaseContext } from "./server.js";
import {
  VETERAN_DEFINITION_URL, isVeteranDefinitionQuestion, contextualVeteranQuestion,
  veteranBenefitClarification,
} from "./veteran-definition.js";

const definition = {
  url: VETERAN_DEFINITION_URL, title: "Who Is a Veteran? — Law Review 26074",
  text: "LAW REVIEW 26074: The veteran definition depends on the governing statute and service facts.",
};
const benefit = {
  ...definition, text: "Benefit eligibility is distinct from the veteran definition. Ask which benefit and which service period.",
};
function client() {
  const calls = [];
  return {
    calls, indexHost: "fixture.invalid", embed: async text => text,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(body.namespace, "");
      return { ok: true, json: async () => ({ matches: body.filter?.url?.$eq === VETERAN_DEFINITION_URL
        ? [definition, benefit].map((metadata, i) => ({ id: `definition-${i}`, score: 0.2, metadata }))
        : Array.from({ length: 15 }, (_, i) => ({ id: `other-${i}`, score: 0.95,
          metadata: { title: "Other benefits", url: `https://www.va.gov/other-${i}`, text: "Unrelated benefits." } })),
      }) };
    },
  };
}

test("status and eligibility questions target the preferred article, including member follow-ups", () => {
  for (const question of ["Am I a veteran?", "Do I qualify for veteran benefits?", "VA benefit eligibility", "What does 26074 say?"]) {
    assert.equal(isVeteranDefinitionQuestion(question), true, question);
  }
  assert.equal(isVeteranDefinitionQuestion("What is my drill pay?"), false);
  const history = [{ role: "user", content: "Am I a veteran after Reserve service?" }];
  assert.match(contextualVeteranQuestion("Honorable discharge", history), /Veteran status/);
  assert.equal(contextualVeteranQuestion("What about BAH?", history), "What about BAH?");
  assert.match(contextualVeteranQuestion("Disability compensation", history), /Veteran status/);
  assert.match(veteranBenefitClarification(
    "Am I a veteran after 20 years in the Reserve? Do I qualify for VA benefits?", [definition],
  ), /Which benefit or purpose/);
  assert.equal(veteranBenefitClarification("Do I qualify for veteran home loan benefits?", [definition]), null);
  assert.equal(veteranBenefitClarification("Am I a veteran?", []), null);
});

test("26074 is explicitly retrieved from the full member corpus and cannot be crowded out", async () => {
  const retrievalClient = client();
  const kb = await getKnowledgeBaseContext("Am I a veteran after Reserve service?", { retrievalClient });
  assert.equal(kb.retrieval.veteranDefinitionAvailable, true);
  assert.ok(retrievalClient.calls.some(call => !call.filter));
  assert.ok(retrievalClient.calls.some(call => call.filter?.url?.$eq === VETERAN_DEFINITION_URL));
  assert.match(kb.context, /veteran definition depends/);
  assert.match(kb.context, /Benefit eligibility is distinct/);
  const articleOnly = await getKnowledgeBaseContext("Am I a veteran?", { chatMode: "law_center", retrievalClient: client() });
  assert.equal(articleOnly.retrieval.generalMatches, 0);
  assert.equal(articleOnly.retrieval.veteranDefinitionAvailable, true);
  assert.ok(articleOnly.sourceDocuments.every(document => document.url === VETERAN_DEFINITION_URL));
});

test("the member receives a clickable 26074 reference only when its passages were retrieved", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalCreate = Anthropic.Messages.prototype.create;
  Anthropic.Messages.prototype.create = async params => fixtureVaReview(params);
  const originalClient = app.locals.retrievalClient;
  Anthropic.Messages.prototype.stream = () => ({ async *[Symbol.asyncIterator]() {
    yield { type: "content_block_delta", delta: { type: "text_delta",
      text: "Which benefit are you asking about, and what type of duty did you perform?" } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
  } });
  const server = app.listen(0);
  try {
    app.locals.retrievalClient = client();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Am I a veteran after Reserve service?" }),
    });
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.match(events.at(-1).finalText, /Law Review 26074/);
    assert.ok(events.at(-1).sources.includes(VETERAN_DEFINITION_URL));
    assert.equal(events.filter(event => event.type === "text").length, 1);
    assert.match(events.at(-1).finalText, /Which benefit or purpose/);
    assert.doesNotMatch(events.at(-1).finalText, /you are eligible|you are ineligible|you don't qualify/i);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    Anthropic.Messages.prototype.create = originalCreate;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
