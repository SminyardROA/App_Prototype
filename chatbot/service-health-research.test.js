import test from "node:test";
import assert from "node:assert/strict";
import { isServiceHealthStatement, isHerbicideResearch } from "./service-health-research.js";
import { isVaDisabilityQuestion, resolveVaDisabilityQuestion, focusedVaSearchQuery,
  relevantVaDisabilityDocuments } from "./va-disability.js";
import { vaCfrPlans, cfrPlanMatch } from "./va-cfr-retrieval.js";
import { getKnowledgeBaseContext, sourceDocument } from "./server.js";

const question = "I served in Vietnam from 1968-1971 and now have lung cancer.";
const primary = (section, text, id = section) => ({
  id, score: 0.15, metadata: {
    url: "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=3",
    title: `38 CFR § ${section}`, section, sourceKind: "official-regulation", text,
  },
});
const exposure = primary("3.307", "A veteran who served in the Republic of Vietnam " +
  "during January 9, 1962 through May 7, 1975 shall be presumed to have been exposed to an herbicide agent.");
const diseases = primary("3.309", "(e) Disease associated with exposure to certain herbicide agents. " +
  "If the requirements of § 3.307(a)(6) are met: Respiratory cancers (cancer of the lung, bronchus, larynx, or trachea).");
const unrelated = primary("3.309", "(d) Diseases specific to radiation-exposed veterans. Cancer of the lung.", "radiation");

test("service and health statements trigger research without benefit jargon or a question mark", () => {
  for (const value of [question, "Vietnam 1968 to 1971. Lung cancer.",
    "I served in Viet Nam and have diabetes", "I was in the Navy and now have cancer"]) {
    assert.equal(isServiceHealthStatement(value), true);
    assert.equal(isVaDisabilityQuestion(value), true);
    assert.equal(resolveVaDisabilityQuestion(value).requiresEvidence, true);
  }
  for (const value of ["Tell me the history of the Vietnam war", "I visited Vietnam on vacation",
    "What is lung cancer?", "I served dinner and have cancer"]) {
    assert.equal(isServiceHealthStatement(value), false);
  }
  assert.equal(isHerbicideResearch("I served in Iraq and have lung cancer"), false);
  assert.equal(isHerbicideResearch("What is the Susan Lukas Act?"), false);
});

test("Vietnam context survives a short condition follow-up without inventing an exposure", () => {
  const resolved = resolveVaDisabilityQuestion("What about lung cancer?", [
    { role: "user", content: "I served in Vietnam and have VA disability questions." },
  ]);
  assert.match(resolved.evidenceQuestion, /Vietnam/);
  assert.match(focusedVaSearchQuery(resolved.evidenceQuestion), /Agent Orange/);
  assert.doesNotMatch(focusedVaSearchQuery("VA lung cancer after radiation exposure"), /Agent Orange/);
});

test("recovery validates the herbicide subsection and recognizes cancer-of-the-lung wording", () => {
  const plans = vaCfrPlans(question);
  assert.deepEqual(plans.map(p => p.section), ["3.307", "3.309"]);
  assert.equal(cfrPlanMatch(sourceDocument(diseases), plans[1]), true);
  assert.equal(cfrPlanMatch(sourceDocument(unrelated), plans[1]), false);
  assert.deepEqual(relevantVaDisabilityDocuments(question, [sourceDocument(diseases)]),
    [sourceDocument(diseases)]);
  assert.deepEqual(relevantVaDisabilityDocuments(question, [sourceDocument(
    primary("3.309", "Type 2 diabetes associated with herbicide agents."))]), []);
});

test("implicit question searches the full library and recovers both low-score controlling passages", async () => {
  const queries = [], calls = [];
  const client = {
    indexHost: "fixture.invalid",
    embed: async text => { queries.push(text); return [queries.length]; },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      assert.equal(body.namespace, "");
      return { ok: true, json: async () => ({
        matches: body.filter?.section ? [exposure, diseases, unrelated] : [],
      }) };
    },
  };
  const kb = await getKnowledgeBaseContext(question, { retrievalClient: client });
  assert.ok(calls.some(c => !c.filter), "retain unrestricted member-corpus search");
  assert.ok(calls.some(c => c.filter?.type?.$eq === "law-center-pdf"));
  assert.ok(queries.some(q => /Agent Orange/.test(q) && /3\.309/.test(q)));
  for (const section of ["3.307", "3.309"]) {
    assert.ok(calls.some(c => c.filter?.section?.$eq === section && c.vector[0] === 2));
    assert.ok(kb.sourceDocuments.some(d => d.section === section));
  }
  assert.ok(kb.sourceDocuments.some(d => /Respiratory cancers/.test(d.text)));
  assert.ok(!kb.sourceDocuments.some(d => d.text === unrelated.metadata.text));
  assert.equal(kb.retrieval.vaDisabilityEvidence, true);
});
