import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { fixtureVaReview } from "./va-review-fixture.js";
import { app, getKnowledgeBaseContext } from "./server.js";
import {
  VETERAN_DEFINITION_URL, isVeteranDefinitionQuestion, contextualVeteranQuestion,
  veteranBenefitClarification, veteranGuidanceInstruction,
} from "./veteran-definition.js";

const definition = {
  url: VETERAN_DEFINITION_URL, title: "Who Is a Veteran? — Law Review 26074",
  text: "LAW REVIEW 26074: The veteran definition depends on the governing statute and service facts.",
};
const benefit = {
  ...definition, text: "Benefit eligibility is distinct from the veteran definition. Ask which benefit and which service period.",
};
const officialDefinition = {
  title: "38 CFR 3.1 — Definitions", sourceKind: "official-regulation", section: "3.1",
  url: "https://www.ecfr.gov/current/title-38/chapter-I/part-3/section-3.1",
  text: 'Veteran means a person who served in the active military, naval, air, or space service and who was discharged or released under conditions other than dishonorable.',
};
const officialLoan = {
  title: "VA home loan eligibility", url: "https://www.va.gov/housing-assistance/home-loans/eligibility/",
  text: "Selected Reserve members may meet a separate home loan service requirement after six creditable years and an honorable discharge, subject to the applicable conditions. VA determines eligibility through a Certificate of Eligibility.",
};
function client({ article = true, failArticle = false, official = false } = {}) {
  const calls = [];
  const embeddings = [];
  return {
    calls, embeddings, indexHost: "fixture.invalid", embed: async text => { embeddings.push(text); return text; },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(body.namespace, "");
      if (body.filter?.url?.$eq === VETERAN_DEFINITION_URL && failArticle) throw new Error("fixture reference lookup failed");
      return { ok: true, json: async () => ({ matches: body.filter?.url?.$eq === VETERAN_DEFINITION_URL
        ? (article ? [definition, benefit] : []).map((metadata, i) => ({ id: `definition-${i}`, score: 0.2, metadata }))
        : official && !body.filter ? [officialDefinition, officialLoan].map((metadata, i) => ({
          id: `official-${i}`, score: 0.96, metadata,
        }))
        : Array.from({ length: 15 }, (_, i) => ({ id: `other-${i}`, score: 0.95,
          metadata: { title: "Other benefits", url: `https://www.va.gov/other-${i}`, text: "Unrelated benefits." } })),
      }) };
    },
  };
}

test("status and eligibility questions target the preferred article, including member follow-ups", () => {
  for (const question of ["Am I a veteran?", "How can I tell whether I'm a veteran?", "Does having a DD214 make me a veteran?", "Does this mean I'm a veteran?", "Do I qualify for veteran benefits?", "VA benefit eligibility", "What does 26074 say?"]) {
    assert.equal(isVeteranDefinitionQuestion(question), true, question);
  }
  assert.equal(isVeteranDefinitionQuestion("What is my drill pay?"), false);
  const history = [{ role: "user", content: "Am I a veteran after Reserve service?" }];
  assert.match(contextualVeteranQuestion("Honorable discharge", history), /Veteran status/);
  assert.equal(contextualVeteranQuestion("What about BAH?", history), "What about BAH?");
  assert.match(contextualVeteranQuestion("Disability compensation", history), /Veteran status/);
  assert.match(veteranBenefitClarification(
    "How can I tell whether I'm a veteran?", [definition],
  ), /First, what kind of duty/);
  assert.match(veteranBenefitClarification(
    "Am I a veteran after 20 years in the Reserve? Do I qualify for VA benefits?", [definition],
  ), /What kind of duty/, "calendar years alone are not proof of the type of service");
  assert.equal(veteranBenefitClarification("Do I qualify for veteran home loan benefits?", [definition]), null);
  assert.equal(veteranBenefitClarification("Does having a DD214 make me a veteran?", [definition]), null);
  assert.match(veteranBenefitClarification("Am I a veteran?", []), /First, what kind of duty/);
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
    assert.match(events.at(-1).finalText, /First, what kind of duty/);
    assert.doesNotMatch(events.at(-1).finalText, /you are eligible|you are ineligible|you don't qualify/i);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    Anthropic.Messages.prototype.create = originalCreate;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});

test("short service-history answers and benefit choices retain 26074 without re-running the opening", () => {
  const opening = veteranBenefitClarification("How can I tell whether I'm a veteran?", [definition]);
  const history = [
    { role: "user", content: "How can I tell whether I'm a veteran?" },
    { role: "assistant", content: opening },
  ];
  for (const reply of ["16", "sixteen", "90 days", "No", "I have a DD214", "Honorable discharge", "Selected Reserve", "VA home loan", "I only did drills", "I have a 0% VA rating"]) {
    const query = contextualVeteranQuestion(reply, history);
    assert.match(query, /Veteran status \/ benefit eligibility follow-up/, reply);
    assert.ok(isVeteranDefinitionQuestion(query), reply);
    assert.doesNotMatch(veteranBenefitClarification(query, [definition], history) || "", /First, what kind of duty/, reply);
  }
  const longerHistory = [
    ...history,
    { role: "user", content: "Only drill and annual training, no activation" },
    { role: "assistant", content: "Do you have a DD214 or other service records?" },
    { role: "user", content: "No" },
    { role: "assistant", content: "Were you disabled by an injury incurred or aggravated in line of duty?" },
  ];
  assert.match(contextualVeteranQuestion("No", longerHistory), /26074/);
  for (const reply of ["What about BAH?", "My buddy has a home loan question", "Never mind", "What does the Susan Lukas Act say?"]) {
    assert.equal(contextualVeteranQuestion(reply, history), reply);
  }
  assert.equal(contextualVeteranQuestion("90 days", []), "90 days");
  assert.equal(contextualVeteranQuestion("No", [
    ...history, { role: "user", content: "My buddy needs help" },
    { role: "assistant", content: "Did your buddy serve on active duty?" },
  ]), "No", "do not carry member status intake across a change of beneficiary");
});

test("guided instructions cover records, distinct duty types and benefit-specific routes without a new audit gate", () => {
  const instruction = veteranGuidanceInstruction("How can I tell whether I'm a veteran?", [definition]);
  for (const expected of [/ONE next genuinely missing question/, /DD Form 214/, /not an automatic denial/,
    /line of duty/, /existing rating/, /ADT and IDT have different rules/,
    /six-year Selected Reserve/, /IRR/, /additional conditions/, /VA makes benefit decisions/]) {
    assert.match(instruction, expected);
  }
  assert.match(instruction, /\(Honorable, Under Honorable Conditions, etc\.\)/);
  assert.match(instruction, /STANDING GUARD\/RESERVE VETERAN-DEFINITION CAVEAT/);
  assert.match(instruction, /Guard and Reserve initial active duty for training \(IADT\)/);
  assert.match(instruction, /Always preserve the exception/);
  assert.doesNotMatch(instruction, /claim.by.claim.*check|mandatory.*audit/i);
  assert.equal(veteranGuidanceInstruction("What is my drill pay?", [definition]), "");
  const missing = veteranGuidanceInstruction("Am I a veteran?", []);
  assert.match(missing, /ALL relevant supplied RAG sources/);
  assert.match(missing, /No single article is required/);
  assert.match(missing, /Never narrate what could or could not be retrieved/);
  assert.match(missing, /do not invent an article's contents/);
  const withoutArticle = veteranBenefitClarification("How can I tell whether I'm a veteran?", []);
  assert.match(withoutArticle, /First, what kind of duty/);
  assert.doesNotMatch(withoutArticle, /26074|retriev|indexed|missing source|could not find/i);
});

test("a bare 16 after Selected Reserve years advances to sourced research through the chat endpoint", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  const calls = [];
  Anthropic.Messages.prototype.stream = params => {
    calls.push(params);
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta",
        text: `Thanks. Your answer was 16 years in the Selected Reserve. We can examine the separate home-loan route using [Law Review 26074](${VETERAN_DEFINITION_URL}).` } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  const server = app.listen(0);
  try {
    app.locals.retrievalClient = client();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "16",
        conversationHistory: [
          { role: "user", content: "How can I tell whether I'm a veteran? I want to explore a VA home loan." },
          { role: "assistant", content: `Let's check your service history using [Law Review 26074](${VETERAN_DEFINITION_URL}).` },
          { role: "user", content: "Only monthly drills in the Selected Reserve, no other active duty. I was honorably discharged and have a DD214." },
          { role: "assistant", content: "How many years have you completed in the Selected Reserve (a drilling unit or full-time support role, not the Individual Ready Reserve)? If that doesn't apply to your service, let me know." },
        ],
      }),
    });
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(calls.length, 1, JSON.stringify(events.at(-1)));
    assert.match(JSON.stringify(calls[0].system), /SERVICE INTAKE TOPICS ALREADY ADDRESSED/);
    assert.match(calls[0].messages.at(-1).content, /User question: 16$/);
    assert.match(events.at(-1).finalText, /16 years/);
    assert.doesNotMatch(events.at(-1).finalText, /How many years/);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});

test("official full-RAG sources remain usable when the preferred article is absent or its lookup fails", async () => {
  for (const failArticle of [false, true]) {
    const retrievalClient = client({ article: false, failArticle, official: true });
    const kb = await getKnowledgeBaseContext(
      "How does the general veteran definition differ from eligibility for a VA home loan?",
      { retrievalClient },
    );
    assert.equal(kb.retrieval.veteranDefinitionAvailable, false);
    assert.ok(kb.sourceDocuments.some(document => document.url === officialDefinition.url));
    assert.ok(kb.sourceDocuments.some(document => document.url === officialLoan.url));
    assert.match(kb.context, /Veteran means a person/);
    assert.ok(retrievalClient.calls.some(call => !call.filter));
    assert.match(retrievalClient.embeddings[0], /38 USC 101/);
    assert.match(retrievalClient.embeddings[0], /38 CFR 3.1/);
  }
});

test("answers use official sources without retrieval narration or an automatic 26074 footer", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  const calls = [];
  const answer = `The general definition concerns qualifying active service and discharge under conditions other than dishonorable [38 CFR 3.1](${officialDefinition.url}). Home-loan eligibility has its own service routes and conditions [VA home loans](${officialLoan.url}). Which type of duty have you performed?`;
  Anthropic.Messages.prototype.stream = params => {
    calls.push(params);
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: answer } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  const server = app.listen(0);
  try {
    for (const options of [
      { article: false, official: true },
      { article: false, failArticle: true, official: true },
      { article: true, official: true },
    ]) {
      app.locals.retrievalClient = client(options);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "How does the general veteran definition differ from eligibility for a VA home loan?" }),
      });
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)));
      const done = events.at(-1);
      assert.ok(calls.length);
      assert.match(JSON.stringify(calls.at(-1).system), /NOT an exclusive source or a prerequisite/);
      assert.match(JSON.stringify(calls.at(-1).system), /Never narrate what could or could not be retrieved/);
      assert.match(JSON.stringify(calls.at(-1).messages), /Veteran means a person/);
      assert.match(done.finalText, /general definition/);
      assert.doesNotMatch(done.finalText, /retriev|indexed|not found|26074|Related definition reference/i);
      assert.ok(done.sources.includes(officialDefinition.url));
      assert.ok(done.sources.includes(officialLoan.url));
      assert.equal(events.some(event => event.type === "error"), false);
    }
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});

test("source-grounded service-history follow-ups reach generation with the guided instructions", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  const calls = [];
  Anthropic.Messages.prototype.stream = params => {
    calls.push(params);
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta",
        text: `We'll check the service period using [Law Review 26074](${VETERAN_DEFINITION_URL}). Do you have a DD Form 214 or other service record?` } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  const server = app.listen(0);
  try {
    app.locals.retrievalClient = client();
    const history = [
      { role: "user", content: "How can I tell whether I'm a veteran?" },
      { role: "assistant", content: veteranBenefitClarification("How can I tell whether I'm a veteran?", [definition]) },
    ];
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "I served six years in the Selected Reserve, only drills and annual training, no other active duty. I was honorably discharged and have no DD214. I want a VA home loan.",
        conversationHistory: history,
      }),
    });
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(calls.length, 1, `follow-up must reach generation: ${JSON.stringify(events.at(-1))}`);
    assert.match(JSON.stringify(calls[0].system), /VETERAN STATUS GUIDED RESEARCH/);
    assert.match(JSON.stringify(calls[0].system), /SERVICE INTAKE TOPICS ALREADY ADDRESSED/);
    assert.match(events.at(-1).finalText, /DD Form 214 or other service record/);
    assert.ok(events.at(-1).sources.includes(VETERAN_DEFINITION_URL));
    assert.equal(events.at(-1).retrieval.veteranDefinitionAvailable, true);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
