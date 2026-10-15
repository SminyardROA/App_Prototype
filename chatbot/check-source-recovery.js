// Synthetic, read-only retrieval checks; no member conversations or answer
// generation. Run after repairs: NODE_USE_ENV_PROXY=1 node check-source-recovery.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pinecone } from "@pinecone-database/pinecone";
import { getKnowledgeBaseContext } from "./server.js";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";
import { VETERAN_DEFINITION_URL } from "./veteran-definition.js";
import { validateVaCitationLinks } from "./va-disability.js";
import { cfrPart } from "./source-provenance.js";

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const info = await pc.describeIndex(KNOWLEDGE_INDEX);
assertKnowledgeIndex(info);
const client = {
  indexHost: info.host, fetch: globalThis.fetch,
  embed: async text => {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST", signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: KNOWLEDGE_MODEL, input: [text], input_type: "query" }),
    });
    if (!response.ok) throw new Error(`Query embedding failed: HTTP ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  },
};
const cases = [
  { id: "cancer", question: "Which VA disability presumptive rules discuss kidney cancer after herbicide exposure?",
    accepts: docs => docs.some(d => cfrPart(d) === 3 && /kidney cancer/i.test(d.text) && d.section) },
  { id: "exposure", question: "What VA disability presumptive provisions discuss asthma after fine particulate matter exposure?",
    accepts: docs => docs.some(d => cfrPart(d) === 3 && /asthma/i.test(d.text) && /3\.320/.test(d.section || "")) },
  { id: "service-status", question: "Am I a veteran for VA benefits after active duty for training or inactive duty training?",
    accepts: docs => docs.some(d => d.url === VETERAN_DEFINITION_URL && d.documentDate === "2026-10" &&
      /(?:training|ADT|IDT)/i.test(d.text) && Number.isInteger(d.pageStart)) },
  { id: "specific-benefit", question: "What does VA disability compensation guidance say about authorized travel to inactive duty training?",
    accepts: docs => docs.some(d => (cfrPart(d) === 3 && d.section === "3.6" && /travel/i.test(d.text)) ||
      (/lr25013\.pdf$/i.test(d.url) && /travel/i.test(d.text) && d.pageStart)) },
];
const results = [];
for (const item of cases) {
  const kb = await getKnowledgeBaseContext(item.question, { retrievalClient: client });
  const docs = kb.sourceDocuments || [];
  const citation = docs[0] ? validateVaCitationLinks(`See [retrieved source](${docs[0].url}).`, docs) : {};
  const pass = Boolean(item.accepts(docs) && citation.hasRetrievedCitation && !citation.hasUnknownCitation);
  results.push({ id: item.id, pass, status: kb.status || "matched",
    sources: docs.map(d => ({ url: d.url, date: d.documentDate || null,
      section: d.section || null, page: d.pageStart || null })) });
  console.log(`${pass ? "PASS" : "FAIL"} ${item.id}`);
}
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../generated-artifacts/source-quality");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "recovery-results.json"), JSON.stringify(results, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
