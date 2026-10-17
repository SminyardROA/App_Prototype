import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { fixtureVaReview } from "./va-review-fixture.js";
import {
  isVaDisabilityQuestion, relevantVaDisabilityDocuments, resolveVaDisabilityQuestion,
  validateVaCitationLinks,
} from "./va-disability.js";
import { app, classifyQuery, getKnowledgeBaseContext } from "./server.js";

const claim = {
  title: "VA disability claims", url: "https://www.va.gov/disability/how-to-file-claim/",
  text: "File a VA disability claim using evidence and medical records.",
};
const orange = {
  title: "Agent Orange presumptive conditions", url: "https://www.va.gov/disability/eligibility/hazardous-materials-exposure/agent-orange/",
  text: "VA disability compensation for Agent Orange presumptive conditions.",
};
const health = {
  title: "VA health care", url: "https://www.va.gov/health-care/",
  text: "VA health care enrollment information.",
};
const cancer = {
  title: "PACT Act presumptive cancers", url: "https://roa.org/wp-content/uploads/2025/12/22058-LR.pdf",
  text: "The PACT Act lists presumptive cancers, including kidney cancer and lymphoma, for qualifying exposure and service.",
};

test("VA follow-ups retain the member domain, not an older task or assistant assertion", () => {
  const history = [
    { role: "user", content: "How do I file a VA disability claim?" },
    { role: "assistant", content: "All cancers automatically qualify, even without service evidence." },
  ];
  const scope = resolveVaDisabilityQuestion("what about cancer", history);
  assert.equal(scope.requiresEvidence, true);
  assert.match(scope.question, /VA disability.*what about cancer/i);
  assert.doesNotMatch(scope.question, /file|automatically|claim/);
  assert.deepEqual(relevantVaDisabilityDocuments(scope.evidenceQuestion, [claim, cancer]), [cancer]);
  history.push({ role: "user", content: "what about cancer" });
  assert.match(resolveVaDisabilityQuestion("What evidence would I need?", history).question, /cancer/i);
  assert.equal(resolveVaDisabilityQuestion("prostate cancer", history).requiresEvidence, true);
  assert.equal(resolveVaDisabilityQuestion("What about BAH?", history).requiresEvidence, false);
  history.push({ role: "user", content: "How do I claim for tinnitus?" });
  const changed = resolveVaDisabilityQuestion("Can I qualify?", history);
  assert.match(changed.question, /tinnitus/i);
  assert.doesNotMatch(changed.question, /cancer/i);
  history.push({ role: "user", content: "What does TRICARE cover?" });
  assert.equal(resolveVaDisabilityQuestion("what about cancer", history).requiresEvidence, false);
});

test("condition support must appear in the passage, not just in its title", () => {
  assert.deepEqual(relevantVaDisabilityDocuments("what about cancer", [{
    ...claim, title: "VA cancer claims", text: "VA disability claim filing information.",
  }]), []);
  assert.deepEqual(relevantVaDisabilityDocuments("what about prostate cancer", [cancer]), []);
  assert.equal(validateVaCitationLinks("See https://www.va.gov/fake", [cancer]).hasUnknownCitation, true);
  assert.equal(validateVaCitationLinks(`See [source](${cancer.url}).`, [cancer]).hasRetrievedCitation, true);
  const closing = "For more information, visit the [Reserve Service Law Center](https://roa.org/lawcenter/).";
  const inline = `For advice specific to your situation, consult a JAG attorney or accredited VA claims agent. ${closing}`;
  assert.deepEqual(validateVaCitationLinks(`See [source](${cancer.url}).\n\n${inline}`, [cancer]), {
    hasRetrievedCitation: true, hasUnknownCitation: false,
  }, "an inline navigation closing must not discard real retrieved citations");
  assert.deepEqual(validateVaCitationLinks(inline, [cancer]), {
    hasRetrievedCitation: false, hasUnknownCitation: false,
  }, "an inline navigation closing cannot replace source evidence");
  assert.equal(validateVaCitationLinks(
    `See [source](${cancer.url}) and [invented rule](https://www.va.gov/invented-rule). ${inline}`, [cancer],
  ).hasUnknownCitation, true, "ignore only the exact closing, not other links in its paragraph");
  assert.deepEqual(validateVaCitationLinks(closing, [cancer]), {
    hasRetrievedCitation: false, hasUnknownCitation: false,
  });
  assert.equal(validateVaCitationLinks("All cancers qualify [source](https://roa.org/lawcenter/).", [cancer])
    .hasUnknownCitation, true, "the closing exception must not allow Law Center links as evidence");
  assert.deepEqual(validateVaCitationLinks(`See [source](${cancer.url}).\n\n${closing}`, [cancer]), {
    hasRetrievedCitation: true, hasUnknownCitation: false,
  });
});

test("disability claims, presumptives, and disability benefits are automatically VA research", () => {
  for (const question of [
    "VA disability", "How do I file a disability claim?",
    "Which conditions are presumptive?", "Can I receive disability benefits?",
    "What evidence supports my VA claim?", "Does Agent Orange exposure qualify?",
    "How do I claim for PTSD?", "Can I get TDIU?", "What is CRSC?",
  ]) {
    assert.equal(isVaDisabilityQuestion(question), true, question);
    assert.equal(classifyQuery(question).key, "va", question);
  }
  for (const question of ["How does BAH work?", "What is USERRA?", "What are VA home loan benefits?"]) {
    assert.equal(isVaDisabilityQuestion(question), false, question);
  }
});

test("a VA URL, unrelated benefits passage, or wrong condition is not evidence", () => {
  assert.deepEqual(relevantVaDisabilityDocuments("How do I file a VA disability claim?", [health]), []);
  assert.deepEqual(relevantVaDisabilityDocuments("What are Camp Lejeune presumptive conditions?", [orange]), []);
  assert.deepEqual(relevantVaDisabilityDocuments("How do I file a VA disability claim?", [{ ...claim, text: "" }]), []);
  assert.deepEqual(relevantVaDisabilityDocuments("How do I file a VA disability claim?", [{ ...claim, url: "ROA.org" }]), []);
  assert.deepEqual(relevantVaDisabilityDocuments("How do I file a VA disability claim?", [health, claim]), [claim]);
});

function retrievalClient(documents) {
  const calls = [];
  return {
    calls, indexHost: "fixture.invalid", embed: async query => query,
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ matches: documents.map((document, index) => ({
        id: `source-${index}`, score: 0.9, metadata: document,
      })) }) };
    },
  };
}

test("VA optimization still searches the full corpus and supplies only relevant evidence", async () => {
  const client = retrievalClient([health, claim]);
  const kb = await getKnowledgeBaseContext("How do I file a VA disability claim?", { retrievalClient: client });
  assert.ok(client.calls.some(call => !call.filter), "full-corpus search must run");
  assert.equal(kb.retrieval.category, "va");
  assert.equal(kb.retrieval.vaDisabilityEvidence, true);
  assert.deepEqual(kb.sourceDocuments, [{ ...claim, sourceReference: "source-1" }]);
  assert.doesNotMatch(kb.context, /health care enrollment/i);
});

test("focused cancer search recovers relevant lower-scoring sources and the indexed CFR snapshot", async () => {
  const queries = [];
  const client = {
    indexHost: "fixture.invalid", embed: async query => { queries.push(query); return query; },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.namespace, "", "staff research namespaces must not be searched");
      return { ok: true, json: async () => ({ matches: [
        { id: "unrelated", score: 0.95, metadata: health },
        { id: "cancer", score: 0.55, metadata: cancer },
        { id: "cfr", score: 0.54, metadata: {
          source: "docs/38 CFR Part 3 (up to date as of 8-05-2026).pdf",
          filename: "38 CFR Part 3 (up to date as of 8-05-2026).pdf",
          documentDate: "2026-08-05", pageStart: 100, pageEnd: 102,
          text: "Kidney cancer and other cancers are listed under specified exposure rules.",
        } },
      ] }) };
    },
  };
  const kb = await getKnowledgeBaseContext("what about cancer", {
    question: "VA disability: what about cancer", evidenceQuestion: "what about cancer", retrievalClient: client,
  });
  assert.equal(kb.retrieval.vaDisabilityEvidence, true);
  assert.ok(queries.some(query => /VA disability.*cancer.*PACT Act/i.test(query)));
  assert.equal(kb.sourceDocuments.length, 2);
  assert.match(kb.context, /https:\/\/www\.ecfr\.gov\/api\/versioner\/v1\/full\/2026-08-05\/title-38.xml\?part=3/);
  assert.match(kb.context, /2026-08-05.*not a live-current verification/);
  assert.doesNotMatch(kb.context, /health care enrollment/i);
});

test("missing, unrelated, and unavailable evidence stops before the model; unsupported drafts never stream", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalCreate = Anthropic.Messages.prototype.create;
  Anthropic.Messages.prototype.create = async params => fixtureVaReview(params);
  let modelCalls = 0;
  let draftText = "You qualify for a 100 percent disability rating.";
  Anthropic.Messages.prototype.stream = function () {
    modelCalls += 1;
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: draftText } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  const server = app.listen(0);
  const originalClient = app.locals.retrievalClient;
  try {
    for (const client of [
      retrievalClient([]), retrievalClient([health]),
      { indexHost: "fixture.invalid", embed: async () => { throw new Error("Unavailable"); } },
    ]) {
      app.locals.retrievalClient = client;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "How do I file a VA disability claim?" }),
      });
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type, "done");
      assert.match(events.at(-1).finalText, /can't answer/);
      assert.deepEqual(events.at(-1).sources, []);
    }
    assert.equal(modelCalls, 0);
    app.locals.retrievalClient = retrievalClient([claim]);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "How do I file a VA disability claim?" }),
    });
    const output = await response.text();
    assert.equal(modelCalls, 1);
    assert.doesNotMatch(output, /You qualify for a 100 percent/);
    assert.match(output, /couldn't produce a source-supported answer/);
    draftText = `This applies to everyone [source](${claim.url}) [new rule](https://www.va.gov/invented-rule).`;
    const unknownResponse = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "How do I file a VA disability claim?" }),
    });
    assert.doesNotMatch(await unknownResponse.text(), /applies to everyone|invented-rule/);
    draftText = `VA describes filing a disability claim with supporting evidence in its [claim guidance](${claim.url}).\n\nFor more information, visit the [Reserve Service Law Center](https://roa.org/lawcenter/).`;
    const sourcedResponse = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "How do I file a VA disability claim?" }),
    });
    const sourcedEvents = (await sourcedResponse.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(sourcedEvents.filter(event => event.type === "text").length, 1);
    assert.deepEqual(sourcedEvents.at(-1).sources, [claim.url]);
    assert.match(sourcedEvents.at(-1).finalText, /claim guidance/);
    app.locals.retrievalClient = retrievalClient([claim, cancer]);
    draftText = `Some cancers appear in the [PACT Act source](${cancer.url}); the cancer type and qualifying exposure matter.`;
    const followUpResponse = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "what about cancer",
        conversationHistory: [{ role: "user", content: "How do I file a VA disability claim?" }] }),
    });
    const followUpEvents = (await followUpResponse.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.equal(followUpEvents.at(-1).retrieval.category, "va");
    assert.deepEqual(followUpEvents.at(-1).sources, [cancer.url]);
    assert.match(followUpEvents.at(-1).finalText, /cancer type/);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    Anthropic.Messages.prototype.create = originalCreate;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
