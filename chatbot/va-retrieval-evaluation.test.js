import test from "node:test";
import assert from "node:assert/strict";
import { retrievalTargets, retrievalCases } from "./va-retrieval-cases.js";
import { createInventory, matchesTarget, assessRetrieval, renderRetrievalReport } from "./va-retrieval-evaluation.js";
import { resolveVaDisabilityQuestion } from "./va-disability.js";

const target = retrievalTargets.find(target => target.id === "shoulder-motion");
const shoulder = {
  url: "https://www.ecfr.gov/current/title-38/chapter-I/part-4", section: "4.71a",
  title: "Rating schedule", documentDate: "2026-08-05",
  text: "5201 Arm, limitation of motion of: Flexion and/or abduction limited to 25° from side 40 30",
};
const question = { ...retrievalCases.find(item => item.id === "shoulder-motion-ordinary") };
const index = createInventory(retrievalTargets);
index.add(shoulder, "public-record");

test("the 68 synthetic cases have unique IDs and valid source anchors", () => {
  assert.equal(retrievalCases.length, 68);
  assert.equal(new Set(retrievalCases.map(item => item.id)).size, 68);
  assert.equal(new Set(retrievalTargets.map(item => item.id)).size, retrievalTargets.length);
  for (const item of retrievalCases) for (const id of item.targets)
    assert.ok(retrievalTargets.some(target => target.id === id));
  assert.match(retrievalCases.find(item => item.id === "kidney-herbicide-list-check").caution, /NOT/);
});

test("matching checks source identity, section and substantive text, not titles or cited cross-references alone", () => {
  assert.equal(matchesTarget(shoulder, target), true);
  assert.equal(matchesTarget({ ...shoulder, text: "Table of contents", title: "5201 flexion" }, target), false);
  assert.equal(matchesTarget({ ...shoulder, url: "https://ecfr.gov.example.org/part-4" }, target), false);
  assert.equal(matchesTarget({ ...shoulder, section: "4.40", text: "See 4.71a for 5201 flexion" }, target), false);
  assert.equal(matchesTarget({ ...shoulder, section: "4.40", text: "See § 4.71a. 5201 Arm, limitation of motion of: flexion" }, target), false);
  assert.equal(matchesTarget({ ...shoulder, section: "4.71a(b)" }, target), true);
  assert.equal(matchesTarget({ ...shoulder, text: "Evaluate under diagnostic codes 5260 or 5261. Limited flexion." },
    retrievalTargets.find(target => target.id === "knee-flexion")), false);
  const xml = { ...shoulder, url: "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=4" };
  assert.equal(matchesTarget(xml, target), true);
});

test("inventory presence is established separately from similarity search", () => {
  assert.equal(index.evidence["shoulder-motion"].count, 1);
  assert.equal(index.evidence["shoulder-motion"].examples[0].id, "public-record");
  assert.equal(index.evidence["ankle-motion"].count, 0);
  const kb = { sourceDocuments: [shoulder] };
  assert.equal(assessRetrieval(question, retrievalTargets, index.evidence, kb).status, "retrieved");
  assert.equal(assessRetrieval(question, retrievalTargets, index.evidence, { sourceDocuments: [] }).status, "search_miss");
  assert.equal(assessRetrieval(question, retrievalTargets, index.evidence, { sourceDocuments: [] }, [shoulder]).status,
    "filtered_or_context_limit");
  assert.equal(assessRetrieval(question, retrievalTargets, index.evidence, { status: "unavailable" }).status,
    "search_unavailable");
  assert.equal(assessRetrieval(question, retrievalTargets, {}, { sourceDocuments: [] }).status, "baseline_gap");
  assert.equal(assessRetrieval(question, retrievalTargets, {}, kb).status, "inventory_drift");
  assert.equal(assessRetrieval(question, retrievalTargets, index.evidence, kb, [], false).status, "inventory_incomplete");
});

test("mixed questions need each independent source target, not one loosely relevant source", () => {
  const mixed = retrievalCases.find(item => item.id === "mixed-joints");
  const ankle = { ...shoulder, text: "5271 Ankle, limited motion", section: "4.71a" };
  const inventory = createInventory(retrievalTargets);
  inventory.add(shoulder, "s"); inventory.add(ankle, "a");
  assert.equal(assessRetrieval(mixed, retrievalTargets, inventory.evidence,
    { sourceDocuments: [shoulder] }).status, "partial_evidence");
  assert.equal(assessRetrieval(mixed, retrievalTargets, inventory.evidence,
    { sourceDocuments: [shoulder, ankle] }).status, "retrieved");
});

test("short follow-ups use the production member-context resolver", () => {
  const item = retrievalCases.find(item => item.id === "followup-shoulder");
  assert.match(resolveVaDisabilityQuestion(item.question, item.history).question, /shoulder/i);
});

test("downloadable report escapes text, rejects executable source links and states its limits", () => {
  const result = assessRetrieval(question, retrievalTargets, index.evidence, { sourceDocuments: [shoulder] });
  result.question = "<script>alert('x')</script>";
  result.coverage[0].inventoryEvidence = [{ ...result.coverage[0].inventoryEvidence[0], url: "javascript:alert(1)" }];
  const html = renderRetrievalReport({
    createdAt: "2026-10-15", inventory: { records: 1, complete: true },
    summary: { retrieved: 1 }, results: [result],
  });
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /does not generate or verify benefit answers/);
  assert.match(html, /not that the library definitively lacks/);
});
