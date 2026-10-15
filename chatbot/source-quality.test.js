import test from "node:test";
import assert from "node:assert/strict";
import { auditSources, extractionIssues, documentIdentity } from "./audit-source-quality.js";
import { applyRepair, replacementRecords, validateRepairPlan } from "./repair-source-quality.js";
import { chunkDocumentPages, verifyExistingArticle } from "./ingest-voyage.js";
import { canonicalSourceIdentity, cfrPart, sourceContext, sourceQualityRank } from "./source-provenance.js";
import { publicSourceUrl, getKnowledgeBaseContext } from "./server.js";
import { focusedVaSearchQuery, relevantVaDisabilityDocuments, validateVaCitationLinks } from "./va-disability.js";

const doc = () => ({
  identity: "uploaded.pdf", existingIds: ["old-1", "old-2", "old-3"],
  metadata: { title: "38 CFR § 3.309", url: "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=3",
    documentDate: "2026-08-05", sourceSha256: "a".repeat(64), extractionMethod: "ecfr-same-date-xml",
    sourceKind: "official-regulation" },
  chunks: [{ text: "Kidney cancer is discussed for qualifying exposure.", section: "3.309" }],
});

test("audits missing provenance, damaged extraction and duplicate document identities", async () => {
  const metadata = { text: "V eterans ser vice e vidence", source: "docs/uploaded.pdf" };
  const report = await auditSources({
    listPaginated: async () => ({ vectors: [{ id: "a" }, { id: "b" }] }),
    fetch: async () => ({ records: { a: { metadata }, b: { metadata } } }),
  });
  assert.equal(report.namespace, "");
  assert.equal(report.records, 2);
  assert.equal(report.documents.length, 1);
  for (const issue of ["missing-title", "missing-public-url", "missing-document-date", "missing-page-section", "fragmented-words"]) {
    assert.equal(report.documents[0].issues[issue], 2);
  }
  assert.ok(extractionIssues("abc\uFFFDdef").includes("encoding-damage"));
  assert.equal(documentIdentity({ url: "https://assets.roa.org/LR26074definition.pdf" }),
    documentIdentity({ url: "https://roa.org/26074-LR.pdf" }));
});

test("repair plans require explicit member scope, references and nonoverlapping IDs", () => {
  assert.doesNotThrow(() => validateRepairPlan({ namespace: "", documents: [doc()] }));
  for (const plan of [
    { namespace: "roa-nationalsecurity", documents: [doc()] },
    { namespace: "", documents: [doc(), doc()] },
    { namespace: "", documents: [{ ...doc(), chunks: [{ text: "No location" }] }] },
    { namespace: "", documents: [{ ...doc(), metadata: { ...doc().metadata, sourceSha256: "" } }] },
  ]) assert.throws(() => validateRepairPlan(plan));
});

test("backs up original vectors, embeds document input and only retires selected obsolete tails", async () => {
  const document = doc(), records = {
    "old-1": { metadata: { text: "damaged" }, values: [1] },
    "old-2": { metadata: { text: "damaged" }, values: [2] },
    "old-3": { metadata: { text: "damaged" }, values: [3] },
    unrelated: { metadata: { text: "Keep this" }, values: [4] },
  };
  const events = [], unrelated = structuredClone(records.unrelated);
  const index = {
    fetch: async ids => ({ records: Object.fromEntries(ids.filter(id => records[id]).map(id => [id, records[id]])) }),
    upsert: async vectors => { events.push("write"); for (const v of vectors) records[v.id] = v; },
    deleteMany: async ids => { events.push("delete"); assert.deepEqual(ids, ["old-2", "old-3"]); for (const id of ids) delete records[id]; },
  };
  const result = await applyRepair(index, document, {
    backup: async originals => { events.push("backup"); assert.equal(Object.keys(originals).length, 3); },
    embedTexts: async texts => { events.push("embed"); assert.match(texts[0], /Kidney cancer/); return [[0.5]]; },
  });
  assert.deepEqual(events, ["backup", "embed", "write", "delete"]);
  assert.equal(result.retired, 2);
  assert.deepEqual(records.unrelated, unrelated);
  assert.equal(records["old-1"].metadata.embedding_input_type, "document");
  assert.equal(records["old-1"].metadata.section, "3.309");
  assert.equal(records["old-1"].metadata.pageStart, undefined, "XML must not inherit obsolete PDF pages");
});

test("embedding or provenance failures never delete or overwrite records", async () => {
  let writes = 0;
  const index = { fetch: async ids => ({ records: Object.fromEntries(ids.map(id => [id, { metadata: {} }])) }),
    upsert: async () => writes++, deleteMany: async () => writes++ };
  await assert.rejects(applyRepair(index, doc(), { backup: async () => {},
    embedTexts: async () => { throw new Error("Provider unavailable"); } }), /unavailable/);
  await assert.rejects(applyRepair(index, doc(), { expected: new Map(), backup: async () => {} }), /changed since audit/);
  await assert.rejects(applyRepair(index, doc()), /backup is required/);
  assert.equal(writes, 0);
  const expanded = replacementRecords({ ...doc(), existingIds: ["old-1"], chunks: [...doc().chunks, ...doc().chunks] });
  assert.equal(new Set(expanded.map(r => r.id)).size, 2);
});

test("new ingestion preserves PDF pages and confirms pre-existing catalog records instead of duplicating them", async () => {
  const chunks = chunkDocumentPages(`${"First page text. ".repeat(20)}\f${"Second page text. ".repeat(20)}\f`);
  assert.deepEqual(chunks.map(c => c.pageStart), [1, 2]);
  assert.ok(chunks.every(c => c.pageStart === c.pageEnd));
  const article = { url: "https://assets.roa.org/LR26074definition.pdf", indexedRecordId: "legacy-id" };
  const index = { fetch: async ids => {
    assert.deepEqual(ids, ["legacy-id"]);
    return { records: { "legacy-id": { metadata: { text: "Verified text", url: article.url, model: "voyage-law-2" } } } };
  } };
  assert.equal(await verifyExistingArticle(index, article), true);
  assert.equal(await verifyExistingArticle(index, { url: "https://roa.org/unindexed.pdf" }), false);
  await assert.rejects(verifyExistingArticle({ fetch: async () => ({ records: {} }) }, article), /refusing duplicate/);
  assert.equal(canonicalSourceIdentity(article.url), canonicalSourceIdentity("https://roa.org/26074-LR.pdf"));
});

test("only exact verified uploaded identities get URLs; date and proposal limits remain explicit", () => {
  assert.equal(publicSourceUrl("docs/38 CFR Part 199 (up to date as of 9-01-2026).pdf"),
    "docs/38 CFR Part 199 (up to date as of 9-01-2026).pdf");
  const official = doc().metadata;
  assert.equal(cfrPart(official), 3);
  assert.equal(cfrPart({ url: official.url.replace("ecfr.gov", "ecfr.gov.example.org") }), null);
  assert.equal(cfrPart({ url: official.url.replace("title-38", "title-13") }), null);
  const proposal = { text: "Proposed updates to sleep apnea ratings.", url: "https://roa.org/article.pdf",
    legalStatus: "proposal-discussion", sourceKind: "roa-analysis", documentDate: "2025-03" };
  const context = sourceContext(proposal, 0);
  assert.match(context, /PROPOSAL DISCUSSION/);
  assert.match(context, /not an enacted rule/);
  assert.match(context, /2025-03.*not a live-current verification/);
  assert.ok(sourceQualityRank(official) > sourceQualityRank(proposal));
  assert.match(sourceContext({ text: "Text", ingestionDate: "2026-10-15" }, 0), /Document date unknown/);
  assert.doesNotMatch(sourceContext({ text: "Text", ingestionDate: "2026-10-15" }, 0), /2026-10-15/);
});

test("cancer and exposure recovery includes exact sections, dated analysis and approved-only queries", async () => {
  const herbicide = focusedVaSearchQuery("VA kidney cancer following herbicide exposure");
  assert.match(herbicide, /38 CFR 3\.307 3\.309/);
  assert.match(herbicide, /herbicide exposure/);
  assert.doesNotMatch(herbicide, /PACT Act/);
  assert.match(focusedVaSearchQuery("VA cancer following radiation exposure"), /3\.311 radiation/);
  const official = { ...doc().metadata, text: "Kidney cancer is included for specified herbicide exposure.", section: "3.309" };
  const dated = { url: "https://roa.org/historical.pdf", text: "VA disability kidney cancer discussion; proposed legislation would expand Agent Orange coverage.",
    title: "Historical Agent Orange analysis", documentDate: "2016-03", legalStatus: "proposal-discussion", sourceKind: "roa-analysis" };
  const calls = [];
  const kb = await getKnowledgeBaseContext("VA disability kidney cancer after Agent Orange exposure", { retrievalClient: {
    indexHost: "fixture.invalid", embed: async text => text,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      assert.equal(body.namespace, "");
      return Response.json({ matches: [
        { id: "dated", score: 0.95, metadata: dated },
        { id: "official", score: 0.85, metadata: official },
      ] });
    },
  } });
  assert.equal(kb.sourceDocuments[0].url, official.url);
  assert.match(kb.context, /Section: 3.309/);
  assert.match(kb.context, /PROPOSAL DISCUSSION/);
  assert.ok(kb.sourceDocuments.some(d => d.url === dated.url), "useful historical analysis is retained");
  assert.ok(calls.some(c => c.filter?.sourceKind?.$eq === "official-regulation"));
  assert.ok(calls.some(c => !c.filter), "full approved corpus remains searchable");
  assert.deepEqual(validateVaCitationLinks(`See [regulation](${official.url}).`, kb.sourceDocuments),
    { hasRetrievedCitation: true, hasUnknownCitation: false });
  assert.equal(validateVaCitationLinks("You qualify [source](https://va.gov/invented).", kb.sourceDocuments).hasUnknownCitation, true);
  assert.deepEqual(relevantVaDisabilityDocuments("VA prostate cancer disability benefits", [official]), []);
});
