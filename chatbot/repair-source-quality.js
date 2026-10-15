// Targeted repairs only. Requires a reviewed plan produced from the default
// namespace audit; never deletes an index, namespace, or unrelated document.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pinecone } from "@pinecone-database/pinecone";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, "../generated-artifacts/source-quality");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");

export function validateRepairPlan(plan) {
  if (plan.namespace !== "" || !Array.isArray(plan.documents) || !plan.documents.length) {
    throw new Error("Repairs require an explicit default-namespace document allowlist");
  }
  const ids = new Set();
  for (const doc of plan.documents) {
    if (!doc.existingIds?.length || !doc.chunks?.length ||
        !/^https:\/\//.test(doc.metadata?.url || "") ||
        !/^[a-f0-9]{64}$/.test(doc.metadata?.sourceSha256 || "") ||
        !doc.metadata.documentDate || !doc.metadata.extractionMethod) {
      throw new Error("Repair lacks verified source provenance");
    }
    for (const id of doc.existingIds) {
      if (ids.has(id)) throw new Error("Repair documents overlap");
      ids.add(id);
    }
    if (doc.chunks.some(c => !c.text?.trim() || c.text.length > 10000 ||
        !(c.section || Number.isInteger(c.pageStart)))) throw new Error("Repair lacks bounded text with section/page references");
  }
}

export function replacementRecords(doc) {
  return doc.chunks.map((chunk, i) => ({
    id: doc.existingIds[i] || `source-repair-${doc.metadata.sourceSha256}-chunk-${i}`,
    metadata: { ...doc.metadata, ...chunk, model: KNOWLEDGE_MODEL,
      embedding_input_type: "document", documentIdentity: doc.metadata.documentIdentity || doc.identity,
      chunkIndex: i, chunkCount: doc.chunks.length, qualityRevision: doc.metadata.sourceSha256 },
  }));
}

async function embed(texts) {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST", signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: KNOWLEDGE_MODEL, input_type: "document", input: texts }),
  });
  if (!response.ok) throw new Error(`Embedding failed: HTTP ${response.status}`);
  const body = await response.json();
  const data = [...(body.data || [])].sort((a, b) => a.index - b.index);
  if (data.length !== texts.length || data.some(d => d.embedding?.length !== 1024 ||
      d.embedding.some(v => !Number.isFinite(v)))) throw new Error("Invalid embedding response");
  return data.map(d => d.embedding);
}

export async function applyRepair(index, doc, { embedTexts = embed, backup, expected } = {}) {
  // Capture complete original vectors before any writes. Five IDs per fetch
  // bounds legacy encoded URL sizes; only these IDs may later be retired.
  const originals = {};
  for (let i = 0; i < doc.existingIds.length; i += 5) {
    Object.assign(originals, (await index.fetch(doc.existingIds.slice(i, i + 5))).records || {});
  }
  for (const id of doc.existingIds) {
    if (!originals[id]) throw new Error("A planned original record is missing");
    if (expected && expected.get(id) !== hash(JSON.stringify(originals[id].metadata))) {
      throw new Error("Source changed since audit; re-audit before repair");
    }
  }
  if (!backup) throw new Error("A vector backup is required before repair");
  await backup(originals);
  const replacements = replacementRecords(doc);
  // Stage every new embedding before changing any indexed text.
  const vectors = [];
  for (let i = 0; i < replacements.length; i += 16) {
    const batch = replacements.slice(i, i + 16);
    const embeddings = await embedTexts(batch.map(r => `Document: ${r.metadata.title}\n${r.metadata.text}`));
    vectors.push(...batch.map((r, j) => ({ ...r, values: embeddings[j] })));
  }
  for (let i = 0; i < vectors.length; i += 50) await index.upsert(vectors.slice(i, i + 50));
  // Eventual consistency: verify every replacement before retiring old tails.
  for (let attempt = 0; attempt < 8; attempt++) {
    let valid = true;
    for (let i = 0; i < vectors.length; i += 5) {
      const records = (await index.fetch(vectors.slice(i, i + 5).map(v => v.id))).records || {};
      for (const vector of vectors.slice(i, i + 5)) {
        if (records[vector.id]?.metadata?.text !== vector.metadata.text ||
            records[vector.id]?.metadata?.qualityRevision !== doc.metadata.sourceSha256) valid = false;
      }
    }
    if (valid) {
      const retained = new Set(vectors.map(v => v.id));
      const obsolete = doc.existingIds.filter(id => !retained.has(id));
      for (let i = 0; i < obsolete.length; i += 100) await index.deleteMany(obsolete.slice(i, i + 100));
      return { identity: doc.identity, before: doc.existingIds.length, after: vectors.length,
        retired: obsolete.length, sourceSha256: doc.metadata.sourceSha256 };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Replacement verification failed; original tails retained, backup available");
}

async function main() {
  const plan = JSON.parse(fs.readFileSync(path.join(output, "repair-plan.json"), "utf8"));
  validateRepairPlan(plan);
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ namespace: "", documents: plan.documents.length,
      before: plan.documents.reduce((n, d) => n + d.existingIds.length, 0),
      after: plan.documents.reduce((n, d) => n + d.chunks.length, 0), failures: plan.failures }));
    return;
  }
  const audit = fs.readFileSync(path.join(output, "records.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  // JSON object order is not stable over provider serialization.
  const stable = value => JSON.stringify(value, Object.keys(value).sort());
  const expected = new Map(audit.map(r => [r.id, hash(stable(r.metadata))]));
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  assertKnowledgeIndex(await pc.describeIndex(KNOWLEDGE_INDEX));
  const rawIndex = pc.index(KNOWLEDGE_INDEX).namespace("");
  // Canonicalize metadata before checking the audit fingerprint.
  const index = {
    fetch: async ids => {
      const result = await rawIndex.fetch(ids);
      for (const record of Object.values(result.records || {})) {
        record.metadata = JSON.parse(stable(record.metadata));
      }
      return result;
    },
    upsert: vectors => rawIndex.upsert(vectors),
    deleteMany: ids => rawIndex.deleteMany(ids),
  };
  const ledgerPath = path.join(output, "repair-results.json");
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : [];
  const backupDir = path.join(output, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  for (const doc of plan.documents) {
    if (ledger.some(r => r.identity === doc.identity && r.sourceSha256 === doc.metadata.sourceSha256)) continue;
    const result = await applyRepair(index, doc, {
      expected, backup: records => fs.writeFileSync(path.join(backupDir, `${hash(doc.identity)}.json`), JSON.stringify(records), { flag: "wx" }),
    });
    ledger.push(result);
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(JSON.stringify(result));
  }
  // Metadata catalogs are updated only after the exact sources are verified
  // and all requested writes have succeeded. Mark already-indexed URLs done.
  const catalogPath = path.join(root, "lr-articles.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const donePath = path.join(root, "ingest-progress.json");
  const done = new Set(JSON.parse(fs.readFileSync(donePath, "utf8")));
  const sources = [];
  for (const doc of plan.documents) {
    const m = doc.metadata;
    const indexedRecordId = replacementRecords(doc)[0].id;
    sources.push({ identity: doc.identity, ...m, chunks: doc.chunks.length, indexedRecordId });
    if (m.sourceKind !== "roa-analysis") continue;
    const existing = catalog.find(a => a.url === m.url);
    const entry = { url: m.url, title: m.title, source: m.source, documentDate: m.documentDate,
      documentIdentity: m.documentIdentity, sourceSha256: m.sourceSha256, currency: m.currency,
      legalStatus: m.legalStatus, indexedRecordId };
    if (existing) Object.assign(existing, entry); else catalog.push(entry);
    done.add(m.url);
  }
  for (const failure of plan.failures || []) {
    if (!/\/LR26\d{3}/i.test(failure.identity)) continue;
    const original = audit.find(r => r.metadata.url === failure.identity);
    if (!original || catalog.some(a => a.url === failure.identity)) continue;
    catalog.push({ url: failure.identity, title: original.metadata.title,
      source: "ROA Service Members Law Center", indexedRecordId: original.id,
      verificationStatus: "indexed-only-public-document-unavailable" });
    done.add(failure.identity);
  }
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  fs.writeFileSync(donePath, JSON.stringify([...done], null, 2));
  fs.writeFileSync(path.join(root, "verified-sources.json"), JSON.stringify(sources, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
