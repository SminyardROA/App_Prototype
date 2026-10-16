import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  TRAINING_STATUTE_URL, isTrainingServiceResearch, selectTrainingAuthority,
  trainingAuthorityInstruction,
  normalizeTrainingCitationLists,
} from "./training-authority.js";
import { app, getKnowledgeBaseContext } from "./server.js";
import { VETERAN_DEFINITION_URL } from "./veteran-definition.js";

const passages = [
  '(2) The term “veteran” means a person who served in the active military, naval, air, or space service, and who was discharged or released therefrom under conditions other than dishonorable.',
  '(21) The term “active duty” means— (A) full-time duty in the Armed Forces, other than active duty for training;',
  '(22) The term “active duty for training” means— (A) full-time duty in the Armed Forces performed by Reserves for training purposes;',
  '(23) The term “inactive duty training” means— (A) duty (other than full-time duty) prescribed for Reserves;',
  '(24) The term “active military, naval, air, or space service” includes— (A) active duty; (B) any period of active duty for training during which the individual concerned was disabled or died from a disease or injury incurred or aggravated in line of duty; and (C) any period of inactive duty training during which the individual concerned was disabled or died— (i) from an injury incurred or aggravated in line of duty; or (ii) from an acute myocardial infarction, a cardiac arrest, or a cerebrovascular accident occurring during such training.',
];
const statute = {
  id: "training-statute-companion", score: 0.1,
  metadata: {
    url: TRAINING_STATUTE_URL, title: "38 U.S. Code § 101 - Definitions",
    section: "101", sourceKind: "us-statute",
    text: passages.join("\n\n"),
  },
};
const article = { id: "law-review-26074", score: 0.99, metadata: {
  url: VETERAN_DEFINITION_URL, title: "Law Review 26074",
  text: "Guard and Reserve Veteran status. VA disability claims for active duty for training and inactive duty training have different service-connected disability rules.",
} };
const regulation = { id: "cfr-service", score: 0.1, metadata: {
  url: "https://www.ecfr.gov/current/title-38/part-3/section-3.6",
  title: "38 CFR 3.6 Duty periods", section: "3.6", sourceKind: "official-regulation",
  text: "§ 3.6 Active military service includes active duty and any period of active duty for training during which the individual concerned was disabled or died from a disease or injury incurred or aggravated in line of duty.",
} };

test("ordinary training, drill and initial-entry questions trigger legal research, not unrelated pay or civilian training", () => {
  for (const question of [
    "Does basic training make me a veteran?",
    "Can I claim VA disability for a disease incurred during active duty for training? How is this different from weekend drills?",
    "Can a stroke during weekend drills qualify for VA benefits?",
    "What is the difference between annual training and weekend drills?",
    "Do IADT or ACDUTRA count as active duty for veteran status?",
    "Does INACDUTRA count for VA disability?",
    "I had an injury in advanced individual training. Can I file a VA claim?",
  ]) {
    assert.equal(isTrainingServiceResearch(question), true, question);
  }
  for (const question of [
    "What is my annual training pay?", "Help me prepare for a fire drill",
    "What is basic training like?", "I need training for my civilian job",
    "What are the shoulder rating criteria?", "How much is BAH?",
  ]) assert.equal(isTrainingServiceResearch(question), false, question);
});

test("prefers the complete exclusion-and-exceptions passage regardless of semantic score", () => {
  const individual = { ...statute, id: "individual", score: 0.99,
    metadata: { ...statute.metadata, text: passages[1] } };
  assert.deepEqual(selectTrainingAuthority([individual, statute]), [statute]);
  assert.deepEqual(selectTrainingAuthority(passages.map((text, i) => ({
    ...statute, id: `definition-${i}`, metadata: { ...statute.metadata, text },
  }))).map(match => match.id), passages.map((_, i) => `definition-${i}`));
});

test("metadata alone, partial medical rules, wrong titles and foreign sources cannot pin an authority", () => {
  for (const metadata of [
    { ...statute.metadata, text: "Training always makes you a veteran." },
    { ...statute.metadata, url: "https://example.com/uscode/text/38/101" },
    { ...statute.metadata, section: "1110" },
    { ...statute.metadata, sourceKind: "roa-analysis" },
    { ...statute.metadata, title: "10 U.S. Code § 101 - Definitions" },
    { ...statute.metadata, text: passages[4].replace("or a cerebrovascular accident", "") },
  ]) assert.deepEqual(selectTrainingAuthority([{ ...statute, metadata }]), []);
});

function client({ failTarget = false, emptyTarget = false } = {}) {
  const calls = [];
  return { calls, indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(body.namespace, "", "never search staff namespaces");
      let matches;
      if (body.filter?.$and) {
        if (failTarget) throw new Error("private synthetic provider body");
        matches = emptyTarget ? [] : [statute];
      } else if (body.filter?.section?.$eq === "3.6") matches = [regulation];
      else if (body.filter?.url?.$eq === VETERAN_DEFINITION_URL) matches = [article];
      else matches = [article, ...Array.from({ length: 24 }, (_, i) => ({
        id: `ordinary-${i}`, score: 0.99, metadata: {
          title: "Other VA service connection evidence", url: `https://www.va.gov/fixture-${i}`,
          text: "VA disability claims and military service connection evidence for Guard and Reserve members.",
        },
      }))];
      return { ok: true, json: async () => ({ matches }) };
    },
  };
}

const question = "Can I claim VA disability for a disease incurred during active duty for training? How is this different from weekend drills?";

test("full RAG remains available while low-scoring statute, CFR and preferred article survive crowding", async () => {
  const retrievalClient = client();
  const kb = await getKnowledgeBaseContext(question, { retrievalClient });
  assert.ok(kb.context);
  assert.equal(kb.retrieval.trainingAuthoritySelectedChunks, 1);
  assert.equal(kb.sourceDocuments[0].url, TRAINING_STATUTE_URL);
  assert.ok(kb.context.includes("other than active duty for training"));
  assert.ok(kb.context.includes("cerebrovascular accident"));
  assert.ok(kb.sourceDocuments.some(doc => doc.url === regulation.metadata.url));
  assert.ok(kb.sourceDocuments.some(doc => doc.url === VETERAN_DEFINITION_URL));
  assert.ok(retrievalClient.calls.some(call => !call.filter), "full member corpus still searched");
  assert.equal(retrievalClient.calls.filter(call => call.filter?.$and).length, 1);
});

test("a failed or empty targeted lookup preserves other sources without a new refusal gate", async () => {
  for (const options of [{ failTarget: true }, { emptyTarget: true }]) {
    const kb = await getKnowledgeBaseContext(question, { retrievalClient: client(options) });
    assert.ok(kb.context);
    assert.equal(kb.retrieval.trainingAuthoritySelectedChunks, 0);
    assert.equal(kb.retrieval.trainingAuthorityRecoveryFailed, Boolean(options.failTarget));
    assert.ok(kb.sourceDocuments.some(doc => doc.url === regulation.metadata.url));
    assert.doesNotMatch(kb.context, /private synthetic provider body/);
  }
});

test("legacy article-only mode never adds statutory results or queries the full corpus", async () => {
  const retrievalClient = client();
  const kb = await getKnowledgeBaseContext(question, { retrievalClient, chatMode: "law_center" });
  assert.notEqual(kb.retrieval.trainingAuthorityQuery, true);
  assert.ok(retrievalClient.calls.every(call => call.filter));
  assert.equal(kb.sourceDocuments.some(doc => doc.url === TRAINING_STATUTE_URL), false);
});

test("generation receives the actual authority and legal distinction without a second AI claim review", async () => {
  const oldClient = app.locals.retrievalClient;
  const oldStream = Anthropic.Messages.prototype.stream;
  const oldCreate = Anthropic.Messages.prototype.create;
  let generations = 0;
  const answer = "Initial active duty for training is not “active duty” under § 101(21)(A). A qualifying disease or injury can establish active service under § 101(24)(B); IDT has different injury and listed acute-event rules. (Source 1)";
  const server = app.listen(0);
  try {
    app.locals.retrievalClient = client();
    Anthropic.Messages.prototype.create = async () => assert.fail("no second-model claim audit");
    Anthropic.Messages.prototype.stream = params => {
      generations++;
      const system = JSON.stringify(params.system);
      const input = JSON.stringify(params.messages);
      assert.match(system, /TRAINING SERVICE DEFINITIONS/);
      assert.match(system, /Initial active duty for training is not active duty under 101\(21\)\(A\)/);
      assert.match(system, /Do not generalize all diseases to IDT/);
      assert.match(system, /Do not assume that.*basic training.*always means Reserve\/Guard ADT/);
      assert.match(system, /Do not invent their status/);
      assert.match(input, /other than active duty for training/);
      assert.match(input, /cerebrovascular accident/);
      return { async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: answer } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      } };
    };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Does basic training make me a veteran?", conversationHistory: [] }),
    });
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(generations, 1);
    assert.match(events.at(-1).finalText, /not “active duty”/);
    assert.ok(events.at(-1).finalText.includes(`[Source 1](${TRAINING_STATUTE_URL})`));
    assert.ok(events.at(-1).sources.includes(TRAINING_STATUTE_URL));
  } finally {
    app.locals.retrievalClient = oldClient;
    Anthropic.Messages.prototype.stream = oldStream;
    Anthropic.Messages.prototype.create = oldCreate;
    await new Promise(resolve => server.close(resolve));
  }
});

test("no authority instruction is invented for an absent source or unrelated topic", () => {
  assert.equal(trainingAuthorityInstruction(question, []), "");
  assert.equal(trainingAuthorityInstruction("What is BAH?", [{ url: TRAINING_STATUTE_URL }]), "");
});

test("unlinked source lists are normalized without changing existing Markdown links or prose", () => {
  assert.equal(normalizeTrainingCitationLists("The rule (Source 1, Source 5)."),
    "The rule ([Source 1], [Source 5]).");
  const linked = "A source says so. [Source 1](https://example.org) (not a source list)";
  assert.equal(normalizeTrainingCitationLists(linked), linked);
});
