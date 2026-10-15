/**
 * Read-only coverage audit (except --repair-progress). Compares the migration
 * manifest with real records, rather than treating a local completion list as
 * evidence that documents are searchable.
 */
import { Pinecone } from "@pinecone-database/pinecone";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const catalog = read("lr-articles.json");
const done = new Set(read("ingest-progress.json"));
const progress = read("voyage-migration-progress.json");
const manifest = read("voyage-migration-manifest.json");
if (!progress.complete || progress.target !== KNOWLEDGE_INDEX || !manifest.listedComplete) {
  throw new Error("Migration manifest and index cutover do not agree");
}
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
assertKnowledgeIndex(await pc.describeIndex(KNOWLEDGE_INDEX));
const source = pc.index(progress.source);
const target = pc.index(KNOWLEDGE_INDEX);
// The manifest starts after a checkpointed prefix; include that prefix in
// the inventory rather than silently undercounting early legacy records.
const baseIds = [];
let token = null;
while (baseIds.length < manifest.base.listed) {
  const page = await source.listPaginated({ limit: Math.min(100, manifest.base.listed - baseIds.length), ...(token ? { paginationToken: token } : {}) });
  baseIds.push(...(page.vectors || []).map(vector => vector.id));
  token = page.pagination?.next;
  if (!token && baseIds.length < manifest.base.listed) throw new Error("Legacy index prefix is shorter than the migration checkpoint");
}
if (token !== manifest.startToken) throw new Error("Legacy index changed since migration; inventory is not reproducible");
const ids = [...baseIds, ...manifest.pages.flat()];
if (ids.length !== progress.listed) throw new Error("Migration manifest count does not match progress");
const catalogIds = catalog.map(article => article.indexedRecordId || `voyage-${encodeURIComponent(article.url)}-chunk-1`);
const sourceIds = new Set(ids);
const families = {
  voyage: [], lawcenter: [], localPdf: [], relativePdf: [],
  localTxt: [], matrix: [], targeted: [], web: [],
};
for (const id of ids) {
  const family = id.startsWith("voyage-") ? "voyage"
    : id.startsWith("lawcenter-") ? "lawcenter"
    : id.startsWith("localPdf-") ? "localPdf"
    : id.startsWith(".%2F") ? "relativePdf"
    : id.startsWith("localTxt-") ? "localTxt"
    : id.startsWith("matrix-") ? "matrix"
    : id.startsWith("targeted-") ? "targeted" : "web";
  families[family].push(id);
}
// Some original URLs are outside the current catalog. They are candidates
// for editorial review, NOT safe to delete: the corpus also includes sources
// intentionally ingested outside this catalog.
const catalogUrls = new Set(catalog.map(a => a.url));
const outsideCatalog = new Set();
for (const id of families.voyage) {
  const encodedUrl = id.match(/^voyage-(.+)-chunk-\d+$/)?.[1];
  if (!encodedUrl) continue;
  const url = decodeURIComponent(encodedUrl);
  if (!catalogUrls.has(url)) outsideCatalog.add(url);
}
const pinnedIds = [
  ".%2Fjtr.pdf-chunk-136", ".%2Fjtr.pdf-chunk-137",
  "localPdf-133601p-pdf-chunk-5", "localPdf-133601p-pdf-chunk-11",
  "localPdf-133601p-pdf-chunk-12", "localPdf-133601p-pdf-chunk-13",
  "localPdf-Volume-07a-pdf-chunk-373", "localPdf-Volume-07a-pdf-chunk-824",
  ...[1, 2, 3, 4, 5, 6].map(i => `voyage-${encodeURIComponent("https://home.army.mil/knox/5115/6624/4724/Officer_Eliminations_Process.pdf")}-chunk-${i}`),
  ...[1, 2].map(i => `voyage-${encodeURIComponent("https://www.mynavyhr.navy.mil/Portals/55/Reference/MILPERSMAN/1000/1900Separation/1920-010.pdf")}-chunk-${i}`),
];
const familySamples = {};
for (const [family, members] of Object.entries(families)) {
  const samples = [...new Set([members[0], members[Math.floor(members.length / 2)], members.at(-1)])].filter(Boolean);
  const [old, migrated] = await Promise.all([source.fetch(samples), target.fetch(samples)]);
  familySamples[family] = {
    count: members.length,
    samples: samples.map(id => ({
      id,
      originalModel: old.records?.[id]?.metadata?.model || "untagged (integrated/legacy)",
      originalType: old.records?.[id]?.metadata?.type || null,
      migratedModel: migrated.records?.[id]?.metadata?.model || null,
      migratedType: migrated.records?.[id]?.metadata?.type || null,
      textPresent: Boolean(migrated.records?.[id]?.metadata?.text?.trim()),
    })),
  };
}
const missing = [];
const wrongModel = [];
const staleProgress = [];
const recoveredProgress = [];
for (let i = 0; i < catalog.length; i += 5) {
  const articles = catalog.slice(i, i + 5);
  const records = (await target.fetch(catalogIds.slice(i, i + 5))).records || {};
  for (let j = 0; j < articles.length; j++) {
    const article = articles[j], id = catalogIds[i + j];
    const metadata = records[id]?.metadata;
    // Newly verified articles may have been indexed after the migration
    // manifest, or retained under a legacy Law Center ID during repair.
    const valid = metadata?.text?.trim() &&
      metadata.url === article.url && metadata.model === KNOWLEDGE_MODEL;
    if (!valid) missing.push({ url: article.url, id, inSourceManifest: sourceIds.has(id) });
    if (metadata && metadata.model !== KNOWLEDGE_MODEL) wrongModel.push(id);
    if (done.has(article.url) && !valid) staleProgress.push(article.url);
    if (!done.has(article.url) && valid) recoveredProgress.push(article.url);
  }
}
const pinned = {};
for (let i = 0; i < pinnedIds.length; i += 5) {
  const records = (await target.fetch(pinnedIds.slice(i, i + 5))).records || {};
  for (const id of pinnedIds.slice(i, i + 5)) {
    pinned[id] = Boolean(records[id]?.metadata?.text?.trim() &&
      records[id].metadata.model === KNOWLEDGE_MODEL);
  }
}
const stats = await target.describeIndexStats();
const report = {
  source: progress.source, target: KNOWLEDGE_INDEX, model: KNOWLEDGE_MODEL,
  sourceListed: progress.listed, targetWritten: progress.written,
  targetIndexed: stats.totalRecordCount,
  skippedNoText: progress.skippedNoText,
  catalogCount: catalog.length, catalogVerified: catalog.length - missing.length,
  missing, wrongModel, staleProgress, recoveredProgress,
  progressOutsideCatalog: [...done].filter(url => !catalogUrls.has(url)),
  pinned, families: familySamples,
  outsideCatalogVoyageUrlCount: outsideCatalog.size,
  outsideCatalogVoyageUrlExamples: [...outsideCatalog].slice(0, 20),
};
console.log(JSON.stringify(report, null, 2));
if (missing.length || wrongModel.length || staleProgress.length ||
    Object.values(pinned).some(value => !value) ||
    Object.values(familySamples).some(f => f.samples.some(s => !s.textPresent || s.migratedModel !== KNOWLEDGE_MODEL)) ||
    progress.skippedNoText || stats.totalRecordCount < progress.written) {
  throw new Error("Knowledge index audit failed; do not cut over or repair progress");
}
if (process.argv.includes("--repair-progress") && recoveredProgress.length) {
  // Only now may the local completion ledger be reconciled with actual records.
  fs.writeFileSync(path.join(dir, "ingest-progress.json"),
    JSON.stringify([...done, ...recoveredProgress], null, 2));
  console.error(`Reconciled ${recoveredProgress.length} verified catalog URLs`);
}