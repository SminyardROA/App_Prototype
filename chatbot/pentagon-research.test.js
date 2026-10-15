import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  isPentagon911HealthQuestion, isSusanLukasResearchQuestion,
} from "./legislation-topics.js";
import {
  isVaDisabilityQuestion, focusedVaSearchQuery, resolveVaDisabilityQuestion,
  relevantVaDisabilityDocuments,
} from "./va-disability.js";
import { vaCfrPlans } from "./va-cfr-retrieval.js";
import { app, getKnowledgeBaseContext, sourceDocument } from "./server.js";

const question = "I served in the Pentagon on 9/11 and have respiratory issues. Is this a claim?";
const history = [{ role: "user", content: "I have a shoulder injury and have VA disability questions." }];
const proposal = {
  id: "roa-proposal", score: 0.81, metadata: {
    source: "docs/HHRG-119-VR09-20260203-SD004 ROA STATEMENT SUSAN LUKAS ACT.pdf",
    text: "ROA's proposed legislation addresses diseases following service at the Pentagon on September 11, 2001. The bill would establish a presumption. ROA urges Congress to advance H.R. 5339.",
  },
};
const framework = {
  id: "service-connection", score: 0.6, metadata: {
    url: "https://www.ecfr.gov/current/title-38/part-3/section-3.303",
    title: "38 CFR 3.303 Principles relating to service connection",
    section: "3.303",
    text: "§ 3.303 (a) General. Service connection connotes many factors but basically it means that the facts, shown by evidence, establish that a particular injury or disease resulting in disability was incurred coincident with service.",
  },
};

test("the Pentagon respiratory question researches the proposal without requiring its name", () => {
  for (const text of [
    question,
    "I was at the Pentagon on September 11 and developed asthma. Could I file a claim?",
    "On 9/11 I served at the Pentagon. I have breathing problems.",
    "Pentagon, Sept. 11, 2001: respiratory illness and VA benefits?",
    "I served at the Pentagon on 9/11 and have persistent headaches.",
    "I was at the Pentagon on September 11 and now have migraines.",
  ]) {
    assert.equal(isPentagon911HealthQuestion(text), true, text);
    assert.equal(isVaDisabilityQuestion(text), true, text);
    assert.match(focusedVaSearchQuery(text), /Susan E\. Lukas/);
    assert.ok(vaCfrPlans(text).some(p => p.section === "3.303"));
  }
  for (const text of ["My shoulder rating is wrong", "I need Pentagon travel reimbursement",
    "How does the Post-9/11 GI Bill work?", "I have respiratory problems after civilian work"]) {
    assert.equal(isPentagon911HealthQuestion(text), false, text);
    assert.equal(isSusanLukasResearchQuestion(text), false, text);
  }
});

test("headache wording reaches the candidate migraine table without assuming a diagnosis", () => {
  const plans = vaCfrPlans("What are the VA headache rating criteria?");
  assert.ok(plans.some(plan => plan.code === "8100" && plan.section === "4.124a"));
  const scoped = resolveVaDisabilityQuestion("What about headaches?", [
    ...history, { role: "user", content: "I served in the Pentagon on 9/11 and have respiratory problems." },
  ]);
  assert.match(scoped.evidenceQuestion, /Pentagon.*9\/11/);
  assert.doesNotMatch(scoped.evidenceQuestion, /shoulder|respiratory/i);
  assert.equal(isSusanLukasResearchQuestion(scoped.evidenceQuestion), true);
  const named = resolveVaDisabilityQuestion("What about headaches?", [
    { role: "user", content: "Explain the Susan Lukas Act." },
  ]);
  assert.match(named.evidenceQuestion, /Susan Lukas Act/);
  assert.doesNotMatch(named.evidenceQuestion, /I served|my service/i);
  const exposure = resolveVaDisabilityQuestion("How does the Susan Lukas Act relate to headaches?", [
    { role: "user", content: "I served at the Pentagon on 9/11 and have respiratory problems." },
  ]);
  assert.match(exposure.evidenceQuestion, /Pentagon.*9\/11/);
  assert.doesNotMatch(exposure.evidenceQuestion, /respiratory/i);
  const friend = resolveVaDisabilityQuestion("How does VA rate my friend's headaches?", [
    { role: "user", content: "I served at the Pentagon on 9/11 and have respiratory problems." },
  ]);
  assert.doesNotMatch(friend.evidenceQuestion, /Pentagon|respiratory/i);
});

test("a source-specific lookup protects proposal passages alongside headache rules", async () => {
  let targeted = 0;
  const proposals = [proposal, { ...proposal, id: "proposal-details",
    metadata: { ...proposal.metadata, text: "H.R. 5339 would extend VA health care and disability compensation to the proposed Pentagon cohort. It is proposed legislation." } }];
  const migraine = { id: "migraine-table", score: 0.8, metadata: {
    url: "https://www.ecfr.gov/current/title-38/part-4/section-4.124a",
    section: "4.124a", text: "§ 4.124a Schedule of ratings. 8100 Migraine. Rating criteria for characteristic prostrating attacks.",
  } };
  const ordinary = Array.from({ length: 16 }, (_, i) => ({
    id: `ordinary-${i}`, score: 0.99, metadata: {
      url: `https://www.va.gov/disability/fixture-${i}`,
      text: "VA disability headaches and claim evidence.",
    },
  }));
  let unavailable = false;
  const client = { indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.namespace, "");
      if (body.filter?.$or) {
        targeted++;
        if (unavailable) throw new Error("synthetic private provider body");
        return { ok: true, json: async () => ({ matches: proposals }) };
      }
      const matches = body.filter?.section?.$eq === "4.124a" ? [migraine] :
        body.filter?.section?.$eq === "3.303" ? [framework] : ordinary;
      return { ok: true, json: async () => ({ matches }) };
    },
  };
  const text = "I served at the Pentagon on 9/11 and have headaches. What are the VA headache rating criteria?";
  const options = { question: text, evidenceQuestion: text, retrievalClient: client };
  const kb = await getKnowledgeBaseContext(text, options);
  assert.equal(targeted, 1);
  assert.equal(kb.retrieval.proposalSelectedChunks, 2);
  assert.equal(kb.retrieval.proposalRecoveredChunks, 2);
  assert.ok(kb.sourceDocuments.some(doc => /8100\s+Migraine/.test(doc.text)));
  assert.ok(kb.sourceDocuments.some(doc => /3\.303/.test(doc.text)));
  unavailable = true;
  const limited = await getKnowledgeBaseContext(text, options);
  assert.equal(limited.retrieval.proposalRecoveryFailed, true);
  assert.match(limited.context, /not evidence.*absent/i);
  assert.ok(limited.sourceDocuments.length > 0);
  assert.doesNotMatch(limited.context, /synthetic private provider body/);
});

test("the current respiratory issue is researched while the earlier shoulder report remains in history", () => {
  const before = structuredClone(history);
  const scope = resolveVaDisabilityQuestion(question, history);
  assert.equal(scope.requiresEvidence, true);
  assert.equal(scope.question, question);
  assert.equal(scope.evidenceQuestion, question);
  assert.deepEqual(history, before);
  const followup = resolveVaDisabilityQuestion("What about breathing problems?",
    [...history, { role: "user", content: question }]);
  assert.match(followup.evidenceQuestion, /Pentagon.*9\/11/);
  assert.doesNotMatch(followup.evidenceQuestion, /shoulder/i);
});

test("implicit exposure questions retain verified proposal paragraphs without treating them as law", () => {
  const doc = sourceDocument(proposal);
  assert.equal(doc.legalStatus, "proposal-discussion");
  assert.equal(relevantVaDisabilityDocuments(question, [doc]).length, 1);
  assert.equal(relevantVaDisabilityDocuments("My shoulder rating is wrong", [doc]).length, 0);
  assert.equal(relevantVaDisabilityDocuments(question,
    [{ ...doc, legalStatus: undefined, sourceKind: "unknown", text: "An unrelated article." }]).length, 0);
});

test("live-path retrieval selects the proposal and existing service-connection framework", async () => {
  const queries = [];
  const client = {
    indexHost: "fixture.invalid",
    embed: async text => { queries.push(text); return [1]; },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.namespace, "");
      const matches = body.filter?.section ? [framework] : [proposal, framework];
      return { ok: true, json: async () => ({ matches }) };
    },
  };
  const scope = resolveVaDisabilityQuestion(question, history);
  const kb = await getKnowledgeBaseContext(scope.question, {
    question: scope.question, evidenceQuestion: scope.evidenceQuestion, retrievalClient: client,
  });
  assert.equal(kb.retrieval.vaDisabilityEvidence, true);
  assert.ok(kb.sourceDocuments.some(d => d.legalStatus === "proposal-discussion"));
  assert.ok(kb.sourceDocuments.some(d => d.url.includes("section-3.303")));
  assert.ok(queries.some(q => q.includes("Susan E. Lukas")));
  assert.ok(queries.every(q => !/shoulder/i.test(q)));
});

test("generation receives the resolved follow-up context AND earlier member facts", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalCreate = Anthropic.Messages.prototype.create;
  const originalClient = app.locals.retrievalClient;
  let generation;
  const url = sourceDocument(proposal).url;
  let draftText = `ROA describes proposed legislation, not an established entitlement [statement](${url}).`;
  Anthropic.Messages.prototype.stream = function(params) {
    generation = params;
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta",
        text: draftText } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  Anthropic.Messages.prototype.create = async params => {
    const { units, passages } = JSON.parse(params.messages[0].content);
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({
      units: units.map(u => u.text.includes(url)
        ? { id: u.id, status: "supported",
          evidence: [{ passageId: passages.find(p => p.url === url).id }] }
        : { id: u.id, status: "nonclaim" }),
    }) }] };
  };
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async () => ({ ok: true, json: async () => ({ matches: [proposal, framework] }) }),
  };
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What about breathing problems?",
        conversationHistory: [...history, { role: "user", content: "I served in the Pentagon on 9/11." }] }),
    });
    const output = await response.text();
    assert.match(output, /proposed legislation/);
    assert.ok(generation.messages.some(m => m.role === "user" && m.content === history[0].content));
    const current = generation.messages.at(-1).content;
    assert.match(current, /What about breathing problems/);
    assert.match(current, /Current member question in context: VA disability/s);
    assert.match(current, /Pentagon.*9\/11/);
    draftText = "Were you serving on military orders at the Pentagon on 9/11, and have you been diagnosed with a specific respiratory condition?";
    const clarification = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What about breathing problems?",
        conversationHistory: [...history, { role: "user", content: "I served in the Pentagon on 9/11." }] }),
    });
    const clarified = await clarification.text();
    assert.match(clarified, /have you been diagnosed with a specific respiratory condition/);
    assert.doesNotMatch(clarified, /couldn't produce a source-supported answer/);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    Anthropic.Messages.prototype.create = originalCreate;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
