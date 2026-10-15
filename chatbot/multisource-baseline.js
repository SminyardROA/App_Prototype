import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.BASELINE_BASE_URL || "http://127.0.0.1:3000";
const retrievalOnly = process.env.BASELINE_RETRIEVAL_ONLY === "1";
const concurrency = Number(process.env.BASELINE_CONCURRENCY || 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("BASELINE_CONCURRENCY must be an integer from 1 to 4");
}
const cases = JSON.parse(fs.readFileSync(path.join(dir, "multisource-baseline.json"), "utf8")).cases;
if (!Array.isArray(cases) || cases.length < 20 || new Set(cases.map(c => c.id)).size !== cases.length) {
  throw new Error("Expected at least 20 baseline cases with unique IDs");
}
for (const c of cases) {
  if (!c.question || !c.chatMode || !Array.isArray(c.authorities) || c.authorities.length < 2 ||
      !Array.isArray(c.answerChecks) || !c.answerChecks.length) {
    throw new Error(`Incomplete case: ${c.id}`);
  }
  for (const a of c.authorities) {
    if (!a.name || Boolean(a.urlPattern) === Boolean(a.answerPattern)) {
      throw new Error(`${c.id}: authority needs a name and exactly one URL or answer pattern`);
    }
    new RegExp(a.urlPattern || a.answerPattern, "i");
  }
  for (const check of c.answerChecks) {
    if (!check.name || !check.pattern || (check.forbidden !== undefined && typeof check.forbidden !== "boolean")) {
      throw new Error(`${c.id}: invalid answer check`);
    }
    new RegExp(check.pattern, "i");
  }
}

async function ask(c) {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: c.question, chatMode: c.chatMode }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new Error(`Chat HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamed = "";
  let done = null;
  const consume = line => {
    if (!line.startsWith("data: ")) return;
    const event = JSON.parse(line.slice(6));
    if (event.type === "text") streamed += event.text;
    if (event.type === "done") done = event;
    if (event.type === "error") throw new Error(event.message || "Chat stream error");
  };
  while (true) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(consume);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!done) throw new Error("SSE ended without a done event");
  return { answer: done.finalText || streamed, sources: done.sources || [], retrieval: done.retrieval || {} };
}

async function retrieve(c, getKnowledgeBaseContext, isDd214PathwayQuery) {
  // Mirror the single-turn retrieval input and DD Form 214 policy routing in /chat.
  const query = `User: ${c.question}`;
  const dd214 = isDd214PathwayQuery(query);
  const kb = await getKnowledgeBaseContext(query, {
    chatMode: c.chatMode,
    forceDd214Pathway: dd214,
    includeDd214Policy: dd214,
  });
  const retrievedUrls = [...new Set(
    [...(kb?.context || "").matchAll(/^\[Source \d+: (.+)\]$/gm)]
      .map(match => match[1].split(" — ").at(-1))
  )];
  return { answer: null, sources: kb?.sources || [], retrievedUrls, retrieval: kb?.retrieval || {} };
}

export function score(c, response) {
  const { answer, sources, retrievedUrls, retrieval } = response;
  const authorities = c.authorities.map(a => {
    const matchedUrls = a.urlPattern
      ? sources.filter(s => new RegExp(a.urlPattern, "i").test(s))
      : [];
    const retrievedMatches = a.urlPattern
      ? (retrievedUrls || sources).filter(s => new RegExp(a.urlPattern, "i").test(s))
      : [];
    return {
      name: a.name,
      channel: a.urlPattern ? "visible source URL" : "answer text only",
      matchedUrls,
      retrievedMatches,
      found: a.urlPattern ? matchedUrls.length > 0 : answer === null ? null : new RegExp(a.answerPattern, "i").test(answer),
    };
  });
  const answerChecks = answer === null ? null : c.answerChecks.map(check => ({
    name: check.name,
    found: new RegExp(check.pattern, "i").test(answer) !== Boolean(check.forbidden),
  }));
  const requiredUrls = authorities.filter(a => a.channel === "visible source URL");
  return {
    id: c.id,
    question: c.question,
    chatMode: c.chatMode,
    review: c.review || null,
    answer,
    sources,
    retrievedUrls,
    retrieval,
    authorities,
    answerChecks,
    visibleSourceCoverage: requiredUrls.filter(a => a.found).length,
    retrievedSourceCoverage: requiredUrls.filter(a => a.retrievedMatches.length > 0).length,
    distinctRetrievedCoverage: distinctUrlCoverage(requiredUrls, "retrievedMatches"),
    requiredVisibleSources: requiredUrls.length,
    answerCheckCoverage: answerChecks?.filter(a => a.found).length ?? null,
    requiredAnswerChecks: c.answerChecks.length,
  };
}

function distinctUrlCoverage(authorities, key) {
  const assigned = new Map();
  // Maximum one-to-one matching: the same URL cannot satisfy two expected authorities.
  function assign(index, seen) {
    for (const url of authorities[index][key]) {
      if (seen.has(url)) continue;
      seen.add(url);
      const previous = assigned.get(url);
      if (previous === undefined || assign(previous, seen)) {
        assigned.set(url, index);
        return true;
      }
    }
    return false;
  }
  for (let i = 0; i < authorities.length; i++) assign(i, new Set());
  return assigned.size;
}

function writeReport(results, started) {
  const summary = {
    cases: results.length,
    completed: results.filter(r => !r.error).length,
    withContext: results.filter(r => Number(r.retrieval?.selectedChunks) > 0).length,
    allExpectedRetrievedAuthorities: results.filter(r => !r.error && r.retrievedSourceCoverage === r.requiredVisibleSources).length,
    allExpectedDistinctRetrievedAuthorities: results.filter(r => !r.error && r.distinctRetrievedCoverage === r.requiredVisibleSources).length,
    allExpectedVisibleAuthorities: results.filter(r => !r.error && r.visibleSourceCoverage === r.requiredVisibleSources).length,
    allAnswerChecks: retrievalOnly ? null : results.filter(r => !r.error && r.answerCheckCoverage === r.requiredAnswerChecks).length,
  };
  const report = {
    started,
    finished: new Date().toISOString(),
    endpoint: baseUrl,
    mode: retrievalOnly ? "retrieval only (no Anthropic answers)" : "full chat",
    note: "Diagnostic baseline only. The API exposes up to three source URLs in full mode, not all retrieved chunks. URL-pattern misses can be false negatives for Law Center PDFs named only by article number; pattern hits can refer to the wrong document. Distinct URL matches do not prove distinct topical authority. Answer regex matches do not prove accuracy or claim-level citation. Review answers manually.",
    summary,
    results,
  };
  const prefix = retrievalOnly ? "multisource-retrieval-report" : "multisource-baseline-report";
  fs.writeFileSync(path.join(dir, `${prefix}.json`), JSON.stringify(report, null, 2) + "\n");
  const lines = [
    "# Multi-source retrieval baseline",
    "",
    `Run: ${started} · Endpoint: ${baseUrl}`,
    "",
    report.note,
    "",
    `Completed: **${summary.completed}/${summary.cases}** · Context selected: **${summary.withContext}/${summary.cases}** · All expected URL patterns matched retrieved context: **${summary.allExpectedRetrievedAuthorities}/${summary.cases}** (on distinct URLs: **${summary.allExpectedDistinctRetrievedAuthorities}/${summary.cases}**) · All expected URL patterns visible: **${summary.allExpectedVisibleAuthorities}/${summary.cases}** · Answer phrase checks: **${retrievalOnly ? "not run (Anthropic unavailable)" : `${summary.allAnswerChecks}/${summary.cases}`}**`,
    "",
    "| Case | Retrieved authority URLs | Visible authority URLs | Answer phrase checks | Retrieved chunks |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...results.map(r => `| ${r.id} | ${r.retrievedSourceCoverage ?? "error"}/${r.requiredVisibleSources ?? "-"} | ${r.visibleSourceCoverage ?? "error"}/${r.requiredVisibleSources ?? "-"} | ${r.answerCheckCoverage ?? "not run"}/${r.requiredAnswerChecks ?? "-"} | ${r.retrieval?.selectedChunks ?? 0} |`),
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.id}`, "", `**Question:** ${r.question}`, "",
      `**Retrieval:** ${JSON.stringify(r.retrieval || {})}`, "",
      `**Retrieved context URLs:** ${r.retrievedUrls?.join(" ; ") || "none"}`, "",
      `**Visible sources:** ${r.sources?.join(" ; ") || "none"}`, "",
      `**Expected authorities:** ${r.authorities?.map(a =>
        `${a.found === null ? "NOT RUN" : a.found ? "VISIBLE URL MATCH" : a.retrievedMatches.length ? "RETRIEVED URL MATCH BUT HIDDEN" : "NO URL PATTERN MATCH"} ${a.name} (${a.channel}${a.retrievedMatches?.length ? "; retrieved: " + a.retrievedMatches.join(", ") : ""})`
      ).join(" ; ") || "not evaluated"}`, "",
      `**Answer phrase checks:** ${r.answerChecks?.map(a => `${a.found ? "FOUND" : "MISSING"} ${a.name}`).join(" ; ") || "not run"}`, "",
      r.review ? `**Manual review:** ${r.review}` : "",
      r.error ? `**Error:** ${r.error}` : r.answer === null ? "**Answer:** not run" : `**Answer:**\n\n${r.answer}`,
      "");
  }
  fs.writeFileSync(path.join(dir, `${prefix}.md`), lines.join("\n") + "\n");
  return summary;
}

async function main() {
  let retrievalFns;
  if (retrievalOnly) {
    retrievalFns = await import("./server.js");
  } else {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
    if (!health.ok) throw new Error(`Health check HTTP ${health.status}`);
  }
  const started = new Date().toISOString();
  const results = Array(cases.length);
  // A common provider outage produces an SSE error on every case; do not issue
  // 20 paid requests when the first chat cannot complete.
  if (!retrievalOnly) {
    try {
      results[0] = score(cases[0], await ask(cases[0]));
    } catch (error) {
      throw new Error(`Full-chat baseline stopped after the first case: ${error.message}. Run BASELINE_RETRIEVAL_ONLY=1 to measure retrieval without Anthropic.`);
    }
  }
  let next = retrievalOnly ? 0 : 1;
  async function worker() {
    while (next < cases.length) {
      const index = next++;
      const c = cases[index];
      try {
        results[index] = score(c, retrievalOnly
          ? await retrieve(c, retrievalFns.getKnowledgeBaseContext, retrievalFns.isDd214PathwayQuery)
          : await ask(c));
        console.log(`[${index + 1}/${cases.length}] ${c.id}: ${results[index].retrievedSourceCoverage}/${results[index].requiredVisibleSources} retrieved; ${results[index].visibleSourceCoverage}/${results[index].requiredVisibleSources} visible authorities; ${results[index].answerCheckCoverage ?? "not run"} answer checks`);
      } catch (error) {
        results[index] = { id: c.id, question: c.question, error: error.message };
        console.error(`[${index + 1}/${cases.length}] ${c.id}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  console.log(JSON.stringify(writeReport(results, started), null, 2));
  // Other legacy cases remain diagnostic, but SCRA safety regressions fail the run.
  if (results.some(r => r.error || (!retrievalOnly &&
      (r.id.startsWith("scra-guard-") || r.id === "legal-scra-credit-lease") &&
      r.answerCheckCoverage !== r.requiredAnswerChecks))) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Fatal: ${error.message}`); process.exitCode = 1; });
}