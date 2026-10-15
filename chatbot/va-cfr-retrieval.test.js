import test from "node:test";
import assert from "node:assert/strict";
import { vaCfrPlans, cfrPlanMatch, recoverCfrMatches } from "./va-cfr-retrieval.js";
import { getKnowledgeBaseContext, sourceDocument } from "./server.js";
import { resolveVaDisabilityQuestion, focusedVaSearchQuery, isVaDisabilityQuestion, relevantVaDisabilityDocuments } from "./va-disability.js";
import { CLAIM_REVIEW_PROMPT, answerUnits } from "./va-claim-validation.js";
import { config } from "./config.js";
import { shoulderCriteriaAnswer } from "./shoulder-ratings.js";

const primary = (section, text, id = section, score = 0.1) => ({
  id, score, metadata: {
    url: `https://www.ecfr.gov/current/title-38/chapter-I/part-${section.split(".")[0]}`,
    section, text, title: `38 CFR § ${section}`, sourceKind: "official-regulation",
  },
});
const connection = primary("3.303",
  "Service connection means the facts, shown by evidence, establish a particular injury or disease resulting in disability.");
const knee = primary("4.71a", "5260 Leg, limitation of flexion of: Flexion limited to 15 degrees 30.");

test("literal CFR sections and ordinary descriptions create bounded recovery plans", () => {
  assert.ok(vaCfrPlans("What does 38 CFR 3.303 say?").some(p => p.section === "3.303"));
  assert.ok(vaCfrPlans("VA evidence closely balanced").some(p => p.section === "3.102"));
  assert.ok(vaCfrPlans("What are the published tinnitus criteria under 6260?").some(p => p.code === "6260"));
  assert.ok(vaCfrPlans("VA rating criteria when I can't bend my knee").some(p => p.code === "5260"));
  assert.deepEqual(vaCfrPlans("What does 10 CFR 3.303 mean?"), []);
  assert.deepEqual(vaCfrPlans("My criminal trial uses reasonable doubt"), []);
  assert.ok(vaCfrPlans("Explain VA Diagnostic Code 7522").some(p => p.section === "4.115b"));
  assert.ok(vaCfrPlans("VA Diagnostic Code 7804").some(p => p.section === "4.118"));
  assert.ok(vaCfrPlans("What rating criteria discuss how a mental health condition affects work and relationships?")
    .some(p => p.section === "4.130"));
  assert.deepEqual(vaCfrPlans("SSDI mental health rating criteria"), []);
  assert.equal(cfrPlanMatch(sourceDocument(primary("4.115b", "Evaluate under diagnostic codes 7522 or 7523.")),
    vaCfrPlans("VA Diagnostic Code 7522")[0]), false);
});

test("metadata, authority and actual row label are required, not cross-references", () => {
  const plan = vaCfrPlans("Diagnostic Code 5260")[0];
  assert.equal(cfrPlanMatch(sourceDocument(knee), plan), true);
  assert.equal(cfrPlanMatch(sourceDocument(primary("4.71a",
    "Evaluate this femur condition under diagnostic codes 5260 or 5261. Flexion is limited.")), plan), false);
  assert.equal(cfrPlanMatch({ ...sourceDocument(connection), section: "3.307",
    text: "See § 3.303 for service connection." }, { section: "3.303" }), false);
  assert.equal(cfrPlanMatch({ ...sourceDocument(knee), url: "https://example.com/part-4" }, plan), false);
});

test("each component receives a slot before supplementary chunks", () => {
  const plans = vaCfrPlans("VA general service-connection rules and knee-flexion rating criteria");
  const matches = recoverCfrMatches(plans, [connection, knee,
    primary("3.303", "Service connection additional evidence", "extra", 0.99)], sourceDocument, 2);
  assert.ok(matches.some(m => m.id === connection.id));
  assert.ok(matches.some(m => m.id === knee.id));
});

test("low-score verified primary passages survive full-library search and injury filtering", async () => {
  const calls = [];
  const client = {
    indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      assert.equal(body.namespace, "");
      return { ok: true, json: async () => ({
        matches: body.filter?.section ? [connection, knee] : [],
      }) };
    },
  };
  const kb = await getKnowledgeBaseContext("VA general service-connection rules and knee-flexion rating criteria",
    { retrievalClient: client });
  assert.ok(calls.some(call => !call.filter), "retain full member-library search");
  assert.ok(calls.some(call => call.filter?.section?.$eq === "3.303"));
  assert.ok(kb.sourceDocuments.some(d => d.section === "3.303"));
  assert.ok(kb.sourceDocuments.some(d => /5260 Leg/.test(d.text)));
  assert.ok(kb.retrieval.cfrRecoveredChunks >= 2);
});

test("optional recovery errors do not hide successful ordinary retrieval", async () => {
  const client = {
    indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      return body.filter?.section ? { ok: false, status: 503 }
        : { ok: true, json: async () => ({ matches: [{ ...connection, score: 0.9 }] }) };
    },
  };
  const kb = await getKnowledgeBaseContext("What does 38 CFR 3.303 say about service connection?",
    { retrievalClient: client });
  assert.ok(kb.sourceDocuments.length);
  assert.equal(kb.retrieval.cfrRecoveryFailures, 1);
});

test("article-only mode does not run official section queries", async () => {
  const calls = [];
  const client = { indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async (_url, options) => { calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ matches: [] }) }; } };
  await getKnowledgeBaseContext("What does 38 CFR 3.303 say?", { chatMode: "law_center", retrievalClient: client });
  assert.ok(calls.every(call => !call.filter?.section));
});

test("short injury follow-up keeps volunteered inactive-duty context", () => {
  const scope = resolveVaDisabilityQuestion("What about an injury?", [
    { role: "user", content: "What does VA disability compensation require for inactive duty training?" },
  ]);
  assert.match(scope.evidenceQuestion, /inactive duty training/i);
  assert.ok(vaCfrPlans(scope.question).some(plan => plan.section === "3.6"));
});

test("Susan Lukas Act remains a proposal in answer and independent review instructions", () => {
  assert.equal(isVaDisabilityQuestion("What is the Susan Lukas Act?"), true);
  assert.match(focusedVaSearchQuery("Susan Lukas Act"), /ROA proposed legislation/);
  assert.match(CLAIM_REVIEW_PROMPT, /Susan Lukas Act.*ROA proposal, not enacted/);
  assert.match(JSON.stringify(config), /NOT FINAL OR ENACTED LAW/);
  assert.match(CLAIM_REVIEW_PROMPT, /blanket denial of other possible benefits/);
  assert.match(CLAIM_REVIEW_PROMPT, /Dated testimony[\s\S]*CURRENT committee/);
  assert.equal(isVaDisabilityQuestion("Susan E. Lukas 9/11 Servicemember Fairness Act"), true);
  const doc = sourceDocument({ id: "proposal", metadata: {
    source: "docs/HHRG-119-VR09-20260203-SD004 ROA STATEMENT SUSAN LUKAS ACT.pdf",
    text: "The Susan E. Lukas 9/11 Servicemember Fairness Act is a bill ROA urges Congress to advance.",
    legalStatus: "enacted-law",
  } });
  assert.match(doc.url, /^https:\/\/www.congress.gov\/119\/meeting\/house\/118907/);
  assert.equal(doc.legalStatus, "proposal-discussion", "verified proposal status wins over an incorrect stored label");
  const laterParagraph = { ...doc, text: "ROA respectfully urges the Subcommittee to support and advance H.R. 5339 without delay." };
  assert.equal(relevantVaDisabilityDocuments("What does the Susan Lukas Act propose?", [laterParagraph]).length, 1,
    "a paragraph using only the bill number remains linked to verified single-bill testimony");
});

test("legal names and abbreviations do not detach claims from their citations", () => {
  const sentence = "ROA asks the U.S. House to advance the Susan E. Lukas Act. [Statement](https://example.com/statement.pdf)";
  assert.deepEqual(answerUnits(sentence).map(unit => unit.text), [sentence]);
  const next = "Another factual claim needs independent support.";
  assert.deepEqual(answerUnits(`${sentence}\n${next}`).map(unit => unit.text), [sentence, next]);
  assert.equal(answerUnits("Dr. Smith reviewed the evidence. A second sentence follows.").length, 2);
  const answer = shoulderCriteriaAnswer("What are the shoulder motion ratings under 5201?", [{
    ...sourceDocument(knee),
    text: "THE SHOULDER AND ARM Rating Major Minor 5201 Arm, limitation of motion of: Flexion and/or abduction limited to 25° from side 40 30 " +
      "Midway between side and shoulder level (flexion and/or abduction limited to 45°) 30 20 " +
      "At shoulder level (flexion and/or abduction limited to 90°) 20 20 5202 Humerus, other impairment of:",
  }]);
  assert.ok(answer);
  assert.ok(answerUnits(answer).filter(unit => /(?:20|30|40)%/.test(unit.text))
    .every(unit => unit.text.includes("https://www.ecfr.gov/")));
});
