import test from "node:test";
import { cfrPart } from "./source-provenance.js";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
import { app, classifyQuery, getKnowledgeBaseContext } from "./server.js";
import { relevantVaDisabilityDocuments, resolveVaDisabilityQuestion } from "./va-disability.js";
import {
  CFR_PART_4_URL, shoulderMotionCriteria, shoulderCriteriaAnswer,
} from "./shoulder-ratings.js";
import {
  isInjuryResearchQuestion, injuryRegions, isSafeInjuryClarification,
} from "./injury-retrieval.js";

installFixtureVaReviewer();

// Exact rows from the indexed Part 4 snapshot, including extraction defects.
const tableText = "T HE S HOULDER AND A RM Rating Major Minor 5200 Scapulohumer al articulation, ankylosis of: " +
  "Unfavorable, abduction limited t o 25° fr om side 50 40 " +
  "5201 Arm, limitation of motion of: Flexion and/or abduction limited t o 25° fr om side 40 30 " +
  "Midwa y between side and shoulder le vel (flexion and/or abduction limited t o 45°) 30 20 " +
  "At shoulder le vel (flexion and/or abduction limited t o 90°) 20 20 " +
  "5202 Humerus, other impairment of: Loss of head of (flail shoulder) 80 70 " +
  "5203 Cla vicle or scapula, impairment of: Dislocation of 20 20";
const snapshot = {
  text: tableText, filename: "38 CFR Part 4 (up to date as of 8-05-2026).pdf",
  source: "docs/38 CFR Part 4 (up to date as of 8-05-2026).pdf",
  documentDate: "2026", pageStart: 39, pageEnd: 43,
};
const schedule = {
  text: tableText, title: snapshot.filename, url: CFR_PART_4_URL, documentDate: "2026",
};
const secondary = {
  title: "Shoulder summary", url: "https://assets.roa.org/example.pdf",
  text: "VA disability rating under 5201: non-dominant arm slight limitation 10 percent.",
};
const knee = {
  filename: snapshot.filename, source: snapshot.source,
  text: "Rating 5260 Leg, limitation of flexion of: Knee flexion limited to 45 degrees 10.",
};
const general = {
  filename: "38 CFR Part 3 (up to date as of 8-05-2026).pdf",
  source: "docs/38 CFR Part 3 (up to date as of 8-05-2026).pdf",
  text: "Service connection under 3.303: injury incurred in the line of duty.",
};
function client(documents) {
  const calls = [];
  return {
    calls, indexHost: "fixture.invalid", embed: async query => query,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(body.namespace, "", "staff namespaces must remain private");
      return { ok: true, json: async () => ({ matches: documents.map((metadata, i) => ({
        id: `fixture-${i}`, score: i === 0 ? 0.95 : 0.55, metadata,
      })) }) };
    },
  };
}

test("ordinary injury language triggers full VA research, not a clinical diagnosis route", () => {
  for (const question of ["Shoulder injury", "I hurt my knee at drill", "What benefits cover injuries?",
    "VA rating for an ankle sprain", "Torn ACL disability claim", "Hip disability rating"]) {
    assert.equal(isInjuryResearchQuestion(question), true, question);
    assert.equal(classifyQuery(question).key, "va", question);
  }
  for (const question of ["How should I treat a sprained ankle?", "Do I need an ER for my shoulder injury?"]) {
    assert.equal(isInjuryResearchQuestion(question), false, question);
  }
  const scope = resolveVaDisabilityQuestion("What percentage?", [
    { role: "user", content: "I injured my knee during annual training." },
  ]);
  assert.match(scope.question, /knee/i);
  assert.equal(scope.requiresEvidence, true);
  assert.match(resolveVaDisabilityQuestion("Rating criteria", [
    { role: "user", content: "I have a shoulder injury" },
  ]).question, /shoulder/i);
  assert.deepEqual(injuryRegions("shoulder and knee").map(region => region.name), ["shoulder", "knee"]);
});

test("Part 4 local sources become traceable evidence and outperform conflicting rating summaries", async () => {
  const retrievalClient = client([secondary, snapshot, knee, general]);
  const kb = await getKnowledgeBaseContext("What VA disability rating criteria cover a shoulder injury?", { retrievalClient });
  assert.equal(kb.retrieval.shoulderScheduleEvidence, true);
  assert.ok(retrievalClient.calls.some(call => !call.filter));
  assert.ok(retrievalClient.calls.some(call => /38 CFR.*5201/i.test(String(call.vector))));
  assert.ok(kb.sourceDocuments.some(document => cfrPart(document) === 4));
  assert.match(kb.context, /up to date as of 8-05-2026/);
  assert.doesNotMatch(kb.context, /slight limitation 10 percent|5260/);
  assert.ok(kb.sourceDocuments.some(document => cfrPart(document) === 3));
  const kneeSummary = { ...secondary, text: "VA knee disability rating: every knee injury receives 100 percent." };
  const kneeKb = await getKnowledgeBaseContext("What are VA knee injury ratings?", {
    retrievalClient: client([kneeSummary, knee]),
  });
  assert.match(kneeKb.context, /5260/);
  assert.doesNotMatch(kneeKb.context, /100 percent/);
});

test("general injuries can reach multiple CFR parts and supported portions of a mixed-injury question", async () => {
  const appeal = { filename: "38 CFR Part 20.pdf", source: "docs/38 CFR Part 20.pdf",
    url: "https://www.ecfr.gov/current/title-38/chapter-I/part-20",
    text: "Rules for appeals involving claims and evidence." };
  const retrievalClient = client([snapshot, knee, general, appeal]);
  const kb = await getKnowledgeBaseContext("How do I file claims for shoulder and knee injuries?", { retrievalClient });
  assert.ok(kb.sourceDocuments.some(document => document.text.includes("5201")));
  assert.ok(kb.sourceDocuments.some(document => document.text.includes("5260")));
  assert.ok(kb.sourceDocuments.some(document => document.url.endsWith("part-20")));
  assert.equal(shoulderCriteriaAnswer("What are shoulder and knee ratings?", kb.sourceDocuments), null);
  const onlyGeneral = { url: "https://www.ecfr.gov/current/title-38/chapter-I/part-3",
    text: general.text, title: general.filename };
  assert.deepEqual(relevantVaDisabilityDocuments("What about shoulder injuries?", [onlyGeneral]), [onlyGeneral]);
});

test("published percentages are parsed from complete official rows, never filled in from memory", () => {
  assert.deepEqual(shoulderMotionCriteria([schedule]).rows, [
    { degrees: 90, major: 20, minor: 20 }, { degrees: 45, major: 30, minor: 20 },
    { degrees: 25, major: 40, minor: 30 },
  ]);
  assert.equal(shoulderMotionCriteria([secondary]), null);
  assert.equal(shoulderMotionCriteria([{ ...schedule, text: tableText.replace("90°) 20 20", "90°)") }]), null);
  assert.equal(shoulderMotionCriteria([{ ...schedule, text: tableText.replace("Rating Major Minor", "Rating") }]), null);
  const changed = shoulderMotionCriteria([{ ...schedule, text: tableText.replace("90°) 20 20", "90°) 30 30") }]);
  assert.equal(changed.rows[0].major, 30, "derive numbers from the actual source, not constants");
  assert.match(shoulderCriteriaAnswer("What rating for a shoulder injury?", [schedule]), /not a universal rating range/);
  assert.equal(shoulderCriteriaAnswer("Shoulder dislocation rating under 5202", [schedule]), null);
  assert.equal(shoulderCriteriaAnswer("Which arm is major for shoulder ratings?", [schedule]), null);
  assert.equal(shoulderCriteriaAnswer("Shoulder and knees rating criteria", [schedule]), null);
  assert.equal(shoulderCriteriaAnswer("What is the humerus fracture rating?", [schedule]), null);
  assert.equal(shoulderCriteriaAnswer("What is a rotator cuff injury rating?", [schedule]), null);
  assert.doesNotMatch(shoulderCriteriaAnswer("Shoulder limitation of motion rating", [schedule]), /Are you asking about limited motion/);
});

test("citation-free clarifying questions are allowed, but uncited rules and percentages are not", () => {
  assert.equal(isSafeInjuryClarification("Which shoulder condition are you asking about?"), true);
  assert.equal(isSafeInjuryClarification("How much shoulder motion have you lost?"), true);
  assert.equal(isSafeInjuryClarification("When did this happen?"), true);
  assert.equal(isSafeInjuryClarification("I can help research the relevant CFR rules. What body area is injured?"), true);
  for (const text of ["Shoulder injuries qualify for VA compensation. What condition do you have?",
    "What injury guarantees benefits?", "I can help research because every injury is eligible.",
    "You get 20 percent.", "What is your full name?", "See https://www.va.gov/fake"]) {
    assert.equal(isSafeInjuryClarification(text), false, text);
  }
});

test("chat explains the retrieved shoulder schedule, clarifies missing evidence, and never streams a personal rating", async () => {
  const snapshotUrl = "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=4";
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  let modelCalls = 0;
  let draft = "Which shoulder condition are you asking about?";
  Anthropic.Messages.prototype.stream = () => {
    modelCalls++;
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: draft } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  const server = app.listen(0);
  const send = async (message, conversationHistory = []) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationHistory }),
    });
    return (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
  };
  try {
    app.locals.retrievalClient = client([secondary, snapshot]);
    const events = await send("What disability rating could I get for a shoulder injury?");
    assert.equal(modelCalls, 0);
    assert.equal(events.filter(event => event.type === "text").length, 1);
    assert.match(events.at(-1).finalText, /90°.*20%.*20%/);
    assert.match(events.at(-1).finalText, /can't predict your individual/);
    assert.match(events.at(-1).finalText, /2026-08-05.*not a live check/);
    assert.deepEqual(events.at(-1).sources, [snapshotUrl]);
    const sourcedIntake = await send("I have a shoulder injury");
    assert.equal(modelCalls, 0);
    assert.match(sourcedIntake.at(-1).finalText, /research the relevant CFR provisions/);
    assert.doesNotMatch(sourcedIntake.at(-1).finalText, /haven't found a matching source/);
    const followup = await send("Rating criteria", [{ role: "user", content: "I have a shoulder injury" }]);
    assert.match(followup.at(-1).finalText, /90°.*20%.*20%/);
    assert.doesNotMatch(followup.at(-1).finalText, /which body part/i);
    app.locals.retrievalClient = client([]);
    const clarification = await send("I have a shoulder injury");
    assert.equal(modelCalls, 0);
    assert.match(clarification.at(-1).finalText, /For the shoulder issue/);
    assert.doesNotMatch(clarification.at(-1).finalText, /can't answer this disability|20%/);
    app.locals.retrievalClient = client([general]);
    const sourcedContextClarification = await send("What about shoulder injuries?");
    assert.equal(modelCalls, 1);
    assert.match(sourcedContextClarification.at(-1).finalText, /Which shoulder condition/);
    draft = "You qualify for 20 percent for any shoulder injury.";
    const unsafe = await send("What about shoulder injuries?");
    assert.match(unsafe.at(-1).finalText, /couldn't produce a source-supported answer/);
    assert.doesNotMatch(JSON.stringify(unsafe), /You qualify for 20/);
    assert.match(unsafe.at(-1).finalText, /can still help narrow the research/);
    app.locals.retrievalClient = client([knee]);
    draft = `The retrieved knee table lists 10 percent for flexion limited to 45 degrees [Part 4](${snapshotUrl}). I haven't verified a shoulder table for this turn.`;
    const partial = await send("What are the shoulder and knee injury ratings?");
    assert.match(partial.at(-1).finalText, /knee table lists 10 percent/);
    assert.deepEqual(partial.at(-1).sources, [snapshotUrl]);
    app.locals.retrievalClient = client([{
      ...snapshot, text: "Rotator cuff muscle impairment 5304 Rating Major Minor Severe 30 20 Moderate 10 10",
    }]);
    draft = `The retrieved rotator cuff muscle table lists a moderate rating of 10 percent in both columns under 5304 [Part 4](${snapshotUrl}).`;
    const muscle = await send("What are rotator cuff injury ratings under 5304?");
    assert.match(muscle.at(-1).finalText, /moderate rating of 10 percent/);
    app.locals.retrievalClient = client([secondary]);
    const unsupported = await send("What is the shoulder disability rating?");
    assert.match(unsupported.at(-1).finalText, /couldn't verify the applicable percentages/);
    assert.doesNotMatch(unsupported.at(-1).finalText, /10 percent/);
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
