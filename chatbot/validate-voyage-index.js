/**
 * Read-only retrieval comparison. Run only after migrate-voyage-index.js
 * reports completion; prints source coverage and pinned-record checks.
 */
import { Pinecone } from "@pinecone-database/pinecone";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const progress = JSON.parse(fs.readFileSync(path.join(dir, "voyage-migration-progress.json"), "utf8"));
if (!progress.complete) throw new Error("Migration has not completed");
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const oldIndex = pc.index(progress.source);
const newIndex = pc.index(progress.target);
const stats = await newIndex.describeIndexStats();
if ((stats.totalRecordCount || 0) < progress.written) {
  throw new Error(`Incomplete target: ${stats.totalRecordCount} indexed vs ${progress.written} written`);
}
const scenarios = [
  { name: "SCRA loan and lease", question: "National Guard SCRA car loan interest and residential lease termination Title 32 orders", authorities: [{ label: "ROA SCRA interest", pattern: /\/20037-LR\.pdf/i }] },
  { name: "IDT pay and travel", question: "Reserve IDT drill pay versus Joint Travel Regulations IDT travel lodging reimbursement", authorities: [{ label: "JTR", pattern: /(?:^|\/)jtr\.pdf/i }, { label: "FMR 7A", pattern: /volume_07a\.pdf/i }] },
  { name: "DD Form 214-1", question: "DoDI 1336.01 DD Form 214-1 Reserve Component documentation delivery", authorities: [{ label: "DoDI 1336.01", pattern: /133601p\.pdf/i }] },
  { name: "Separation policy", question: "Navy Reserve enlisted administrative separation DoDI 1332.14 MILPERSMAN 1910 notice", authorities: [{ label: "Navy 1910", pattern: /1910-(?:010|402|702)\.pdf/i }, { label: "DoDI 1332.14", pattern: /133214p\.pdf/i }] },
  { name: "Benefits", question: "TRICARE Reserve Select FEHB federal civilian eligibility and SGLI insurance", authorities: [{ label: "TRS", pattern: /tricare\.mil\/Plans\/HealthPlans\/TRS/i }] },
];
let oldHits = 0, newHits = 0, totalAuthorities = 0;
for (const scenario of scenarios) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: progress.model, input: [scenario.question], input_type: "query" }),
  });
  if (!resp.ok) throw new Error(`Voyage query embedding failed: ${resp.status}`);
  const vector = (await resp.json()).data[0].embedding;
  const output = {};
  for (const [label, index] of [["old", oldIndex], ["new", newIndex]]) {
    const result = await index.query({ vector, topK: 20, includeMetadata: true, includeValues: false });
    const matches = result.matches || [];
    output[label] = {
      count: matches.length,
      taggedVoyage: matches.filter(m => m.metadata?.model === progress.model).length,
      distinctUrls: new Set(matches.map(m => m.metadata?.url || m.metadata?.source).filter(Boolean)).size,
      authorityRanks: Object.fromEntries(scenario.authorities.map(authority => [
        authority.label,
        matches.findIndex(m => authority.pattern.test(String(m.metadata?.url || m.metadata?.source))) + 1,
      ])),
      topUrls: matches.slice(0, 3).map(m => m.metadata?.url || m.metadata?.source || m.id),
    };
  }
  totalAuthorities += scenario.authorities.length;
  oldHits += Object.values(output.old.authorityRanks).filter(Boolean).length;
  newHits += Object.values(output.new.authorityRanks).filter(Boolean).length;
  console.log(JSON.stringify({ scenario: scenario.name, ...output }));
}
console.log(JSON.stringify({ labeledEvaluation: { totalAuthorities, oldTop20Hits: oldHits, newTop20Hits: newHits } }));
if (newHits < oldHits) throw new Error("Voyage migration regressed labeled top-20 authority recall");
const ids = [
  "localPdf-133601p-pdf-chunk-5",
  "localPdf-133601p-pdf-chunk-11",
  "localPdf-133601p-pdf-chunk-12",
  "localPdf-133601p-pdf-chunk-13",
  "localPdf-Volume-07a-pdf-chunk-373",
  "localPdf-Volume-07a-pdf-chunk-824",
  ".%2Fjtr.pdf-chunk-136",
  ".%2Fjtr.pdf-chunk-137",
];
const records = await newIndex.fetch(ids);
console.log(JSON.stringify({ pinnedSamples: ids.map(id => ({
  id, present: Boolean(records.records?.[id]?.metadata?.text),
  model: records.records?.[id]?.metadata?.model || null,
})) }));
console.log(JSON.stringify({ targetCount: stats.totalRecordCount, written: progress.written, skippedNoText: progress.skippedNoText }));
if (ids.some(id => !records.records?.[id]?.metadata?.text || records.records[id].metadata.model !== progress.model)) {
  throw new Error("Required pinned policy record missing or not migrated with Voyage");
}