// Explicit live, read-only retrieval evaluation. No Anthropic generation/audit
// calls, corpus mutations, private namespace enumeration, or visitor transcripts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pinecone } from "@pinecone-database/pinecone";
import { auditSources } from "./audit-source-quality.js";
import { retrievalTargets, retrievalCases } from "./va-retrieval-cases.js";
import { createInventory, assessRetrieval, renderRetrievalReport } from "./va-retrieval-evaluation.js";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";
import { getKnowledgeBaseContext, sourceDocument } from "./server.js";
import { resolveVaDisabilityQuestion } from "./va-disability.js";
import { contextualVeteranQuestion } from "./veteran-definition.js";
import { cfrPart, canonicalSourceIdentity } from "./source-provenance.js";

export async function runEvaluation({ output, selectedCases = retrievalCases }) {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const info = await pc.describeIndex(KNOWLEDGE_INDEX);
  assertKnowledgeIndex(info);
  const index = pc.index(KNOWLEDGE_INDEX).namespace("");
  const inventory = createInventory(retrievalTargets);
  fs.mkdirSync(output, { recursive: true });
  const candidateFile = path.join(output, "inventory-candidates.jsonl");
  fs.writeFileSync(candidateFile, "");
  console.log("Reading only the default member namespace to establish source presence...");
  const before = (await index.describeIndexStats()).namespaces?.[""]?.recordCount;
  const inventoryReport = await auditSources(index, {
    onRecords(records) {
      for (const [id, record] of Object.entries(records)) {
        const document = sourceDocument({ ...record, id });
        inventory.add(document, id);
        if ([3, 4, 20].includes(cfrPart(document)) ||
            canonicalSourceIdentity(document.url) === "roa-law-review-26074") {
          fs.appendFileSync(candidateFile, `${JSON.stringify({ id, document })}\n`);
        }
      }
    },
  });
  const after = (await index.describeIndexStats()).namespaces?.[""]?.recordCount;
  const complete = Number.isInteger(before) && before === after && after === inventoryReport.records;
  const report = {
    createdAt: new Date().toISOString(), index: KNOWLEDGE_INDEX, embeddingModel: KNOWLEDGE_MODEL,
    inventory: { namespace: "", records: inventoryReport.records, before, after, complete },
    targets: retrievalTargets.map(({ questions, patterns, ...target }) => ({ ...target, patterns })),
    summary: {}, results: [],
  };
  fs.writeFileSync(path.join(output, "corpus-documents.json"), JSON.stringify(inventoryReport.documents, null, 2));
  fs.writeFileSync(path.join(output, "retrieval-traces.jsonl"), "");
  fs.writeFileSync(path.join(output, "inventory-evidence.json"), JSON.stringify({
    ...report.inventory, createdAt: report.createdAt, evidence: inventory.evidence,
  }, null, 2));
  console.log(`Inventory: ${inventoryReport.records} records; consistent counts: ${complete}.`);
  const embed = async text => {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST", signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: KNOWLEDGE_MODEL, input: [text], input_type: "query" }),
    });
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.data?.[0]?.embedding)) throw new Error("Invalid query embedding");
    return data.data[0].embedding;
  };
  for (const item of selectedCases) {
    const rawDocuments = [];
    const client = { indexHost: info.host, pinecone: pc, embed,
      fetch: async (url, options) => {
        const request = JSON.parse(options.body);
        if (request.namespace && request.namespace !== "") throw new Error("Non-member namespace prohibited");
        const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(45000) });
        if (response.ok && new URL(url).pathname === "/query") {
          const data = await response.clone().json();
          rawDocuments.push(...(data.matches || []).map(sourceDocument));
        }
        return response;
      },
    };
    const veteranQuestion = contextualVeteranQuestion(item.question, item.history);
    const scope = resolveVaDisabilityQuestion(veteranQuestion, item.history);
    const kb = await getKnowledgeBaseContext(scope.question, {
      question: scope.question, evidenceQuestion: scope.evidenceQuestion || scope.question,
      retrievalClient: client,
    });
    const result = assessRetrieval(item, retrievalTargets, inventory.evidence, kb, rawDocuments, complete);
    fs.appendFileSync(path.join(output, "retrieval-traces.jsonl"),
      `${JSON.stringify({ caseId: item.id, kb: { status: kb.status, sourceDocuments: kb.sourceDocuments || [] },
        rawDocuments })}\n`);
    report.results.push(result);
    report.summary[result.status] = (report.summary[result.status] || 0) + 1;
    console.log(`${result.status.padEnd(26)} ${result.id}`);
    // Save progress so interrupted/provider-limited runs remain inspectable.
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, "report.html"), renderRetrievalReport(report));
  console.log(JSON.stringify({ summary: report.summary, report: path.join(output, "report.html") }));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--live")) {
    console.error("Run with --live to read the member index and make paid Voyage/Pinecone retrieval requests. No answer-model calls.");
    process.exitCode = 1;
  } else {
    const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../generated-artifacts/va-retrieval-baseline");
    try {
      const report = await runEvaluation({ output });
      if (report.results.some(result => result.status !== "retrieved")) process.exitCode = 2;
    } catch (error) {
      // Provider messages/stacks can contain request details. Do not print them.
      console.error(JSON.stringify({ status: "evaluation_failed", errorType: error.name }));
      process.exitCode = 1;
    }
  }
}
