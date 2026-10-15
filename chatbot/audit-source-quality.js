// Read-only inventory of member-approved records. Never enumerate namespaces.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Pinecone } from "@pinecone-database/pinecone";
import { KNOWLEDGE_INDEX, assertKnowledgeIndex } from "./knowledge-index.js";

export function extractionIssues(text = "") {
  const issues = [];
  if (text.trim().length < 80) issues.push("short-text");
  if (/\uFFFD|(?:%[0-9A-F]{2}){3}/i.test(text)) issues.push("encoding-damage");
  if (/\b(?:ser vice|V eterans|e vidence|disabilit y|r equire|CF R)\b/.test(text) ||
      (text.match(/\b[a-zA-Z]\b/g) || []).length > Math.max(12, text.length / 40)) issues.push("fragmented-words");
  if ((text.match(/[\u0000-\u0008\u000B\u000E-\u001F]/g) || []).length) issues.push("control-characters");
  return issues;
}

export function documentIdentity(metadata, id = "") {
  const url = String(metadata.url || metadata.source_url || metadata.source || metadata.filename || id).split("#")[0];
  const article = url.match(/(?:\/|LR)(\d{4,5})(?:[-_a-z].*)?\.pdf$/i);
  return /roa\.org/i.test(url) && article ? `law-review-${article[1]}` : url.toLowerCase();
}

export async function auditSources(index, { onRecords = () => {} } = {}) {
  const documents = new Map();
  let token, records = 0;
  do {
    const page = await index.listPaginated({ limit: 100, ...(token ? { paginationToken: token } : {}) });
    const ids = (page.vectors || []).map(v => v.id);
    // Bound encoded URL size, not only ID count, for long legacy IDs.
    const batches = [];
    let batch = [], bytes = 0;
    for (const id of ids) {
      const size = encodeURIComponent(id).length + 5;
      if (bytes + size > 5500 && batch.length) { batches.push(batch); batch = []; bytes = 0; }
      batch.push(id); bytes += size;
    }
    if (batch.length) batches.push(batch);
    const responses = [];
    for (let i = 0; i < batches.length; i += 4) {
      responses.push(...await Promise.all(batches.slice(i, i + 4).map(batch => index.fetch(batch))));
    }
    for (const response of responses) {
      const fetched = response.records || {};
      await onRecords(fetched);
      for (const [id, record] of Object.entries(fetched)) {
        records++;
        const m = record.metadata || {}, key = documentIdentity(m, id);
        if (!documents.has(key)) documents.set(key, { identity: key, chunks: 0, urls: new Set(), titles: new Set(), dates: new Set(),
          idPrefixes: new Set(), textHashes: new Set(), duplicateChunks: 0, issues: {}, examples: [] });
        const d = documents.get(key);
        d.chunks++;
        d.idPrefixes.add(id.replace(/-chunk-\d+(?:-part-\d+)?$/, ""));
        const textHash = createHash("sha256").update(m.text || "").digest("hex");
        if (d.textHashes.has(textHash)) d.duplicateChunks++;
        d.textHashes.add(textHash);
        if (m.url) d.urls.add(m.url);
        if (m.title) d.titles.add(m.title);
        const date = m.documentDate || m.publication_date || m.published_date;
        if (date) d.dates.add(date);
        const issues = [
          ...(!m.title ? ["missing-title"] : []),
          ...(/^(?:No\.?\s*)?\d+$/i.test(String(m.title || "").trim()) ? ["generic-title"] : []),
          ...(!/^https?:\/\//i.test(m.url || "") ? ["missing-public-url"] : []),
          ...(!date ? ["missing-document-date"] : []),
          ...(!(m.pageStart || m.page || m.section) ? ["missing-page-section"] : []),
          ...extractionIssues(m.text || ""),
        ];
        for (const issue of issues) d.issues[issue] = (d.issues[issue] || 0) + 1;
        if (d.examples.length < 2) d.examples.push(id);
      }
    }
    token = page.pagination?.next;
  } while (token);
  return { index: KNOWLEDGE_INDEX, namespace: "", records,
    documents: [...documents.values()].map(({ textHashes, ...d }) => ({ ...d,
      urls: [...d.urls], titles: [...d.titles], dates: [...d.dates], idPrefixes: [...d.idPrefixes] })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  assertKnowledgeIndex(await pc.describeIndex(KNOWLEDGE_INDEX));
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../generated-artifacts/source-quality");
  fs.mkdirSync(output, { recursive: true });
  const fd = fs.openSync(path.join(output, "records.jsonl"), "w");
  try {
    const report = await auditSources(pc.index(KNOWLEDGE_INDEX).namespace(""), {
      onRecords: records => {
        for (const [id, record] of Object.entries(records)) fs.writeSync(fd, JSON.stringify({ id, metadata: record.metadata }) + "\n");
      },
    });
    fs.writeFileSync(path.join(output, "audit.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ namespace: "", records: report.records, documents: report.documents.length }));
  } finally { fs.closeSync(fd); }
}
