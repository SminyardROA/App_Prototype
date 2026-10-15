import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

function integerEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a finite integer from ${min} to ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite integer from ${min} to ${max}`);
  }
  return value;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPort = process.env.BETA_PORT || process.env.PORT || "3000";
const baseUrl = process.env.BETA_BASE_URL || `http://127.0.0.1:${defaultPort}`;
const scenariosPath = path.join(__dirname, "beta-scenarios.json");
const reportPath = path.join(__dirname, "beta-test-100-report.md");
const jsonReportPath = path.join(__dirname, "beta-test-100-report.json");
const concurrency = integerEnv("BETA_CONCURRENCY", 3, { min: 1, max: 10 });
const requestTimeout = integerEnv("BETA_TIMEOUT_MS", 120000, { min: 5000, max: 600000 });
const aiRequestTimeout = integerEnv("BETA_AI_TIMEOUT_MS", 30000, { min: 5000, max: 120000 });
const memberMode = process.env.BETA_MEMBER_MODE || "ai";
const judgeMode = process.env.BETA_AI_JUDGE || "critical";
const memberModel = process.env.BETA_MEMBER_MODEL || config.claudeModel || "claude-opus-4-5";
const judgeModel = process.env.BETA_JUDGE_MODEL || config.claudeModel || "claude-opus-4-5";
const maxAiCalls = integerEnv("BETA_MAX_AI_CALLS", 120, { min: 0, max: 1000 });
let aiCallCount = 0;
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: aiRequestTimeout,
      maxRetries: 1,
    })
  : null;

function loadScenarios() {
  const document = JSON.parse(fs.readFileSync(scenariosPath, "utf8"));
  const scenarios = Array.isArray(document.scenarios) ? document.scenarios : [];
  const ids = new Set(scenarios.map(scenario => scenario.id));
  if (scenarios.length !== 100) {
    throw new Error(`Expected exactly 100 scenarios, found ${scenarios.length}`);
  }
  if (ids.size !== scenarios.length) throw new Error("Scenario IDs must be unique");
  const validCategories = new Set(["pay", "benefits", "legal", "general", "transition"]);
  const validRisks = new Set(["low", "medium", "high", "critical"]);
  for (const scenario of scenarios) {
    if (!scenario.id || !/^[a-z0-9-]+$/.test(scenario.id)) {
      throw new Error(`Invalid scenario ID: ${scenario.id}`);
    }
    if (!validCategories.has(scenario.category)) {
      throw new Error(`${scenario.id}: invalid category`);
    }
    if (!validRisks.has(scenario.risk)) {
      throw new Error(`${scenario.id}: invalid risk`);
    }
    if (typeof scenario.profile !== "string" || scenario.profile.length < 10) {
      throw new Error(`${scenario.id}: profile is required`);
    }
    if (typeof scenario.question !== "string" || scenario.question.length < 10) {
      throw new Error(`${scenario.id}: question is required`);
    }
    if (scenario.chatMode !== undefined &&
        (typeof scenario.chatMode !== "string" || !config.chatModes[scenario.chatMode])) {
      throw new Error(`${scenario.id}: invalid chatMode`);
    }
    if (scenario.expectedAuthorities !== undefined &&
        (!Array.isArray(scenario.expectedAuthorities) || scenario.expectedAuthorities.length < 2 ||
         new Set(scenario.expectedAuthorities.map(item => item.family)).size !== scenario.expectedAuthorities.length ||
         scenario.expectedAuthorities.some(item =>
           !["userraReemployment", "scraLease"].includes(item.family) ||
           typeof item.claim !== "string" || !item.claim))) {
      throw new Error(`${scenario.id}: expectedAuthorities must list distinct known families and claim labels`);
    }
    if (scenario.turns !== undefined) {
      if (!Array.isArray(scenario.turns) || scenario.turns.length < 2) {
        throw new Error(`${scenario.id}: turns must contain at least two turns`);
      }
      for (const [index, turn] of scenario.turns.entries()) {
        if (!turn || typeof turn.message !== "string" || !turn.message.trim()) {
          throw new Error(`${scenario.id}: turn ${index + 1} message is required`);
        }
        for (const field of ["mustMention", "mustNotMention", "sourcesMustInclude"]) {
          if (turn[field] !== undefined && !Array.isArray(turn[field])) {
            throw new Error(`${scenario.id}: turn ${index + 1} ${field} must be an array`);
          }
          for (const pattern of turn[field] || []) {
            if (typeof pattern !== "string" || !pattern) {
              throw new Error(`${scenario.id}: turn ${index + 1} has invalid ${field} pattern`);
            }
            regexp(pattern);
          }
        }
        if (turn.expectedPathwayState !== undefined &&
            !["not_started", "awareness_asked", "review_offered", "completed"].includes(turn.expectedPathwayState)) {
          throw new Error(`${scenario.id}: turn ${index + 1} has invalid expectedPathwayState`);
        }
      }
    }
    if (scenario.maxWords !== undefined &&
        (!Number.isInteger(scenario.maxWords) || scenario.maxWords < 50 || scenario.maxWords > 500)) {
      throw new Error(`${scenario.id}: maxWords must be an integer from 50 to 500`);
    }
    for (const field of ["mustMention", "mustNotMention"]) {
      if (scenario[field] !== undefined && !Array.isArray(scenario[field])) {
        throw new Error(`${scenario.id}: ${field} must be an array`);
      }
      for (const pattern of scenario[field] || []) {
        if (typeof pattern !== "string" || !pattern) throw new Error(`${scenario.id}: invalid ${field} pattern`);
        try {
          regexp(pattern);
        } catch (error) {
          throw new Error(`${scenario.id}: invalid ${field} regex: ${error.message}`);
        }
      }
    }
    for (const field of ["requiresLawReview", "requiresOfficial"]) {
      if (scenario[field] !== undefined && typeof scenario[field] !== "boolean") {
        throw new Error(`${scenario.id}: ${field} must be boolean`);
      }
    }
  }
  return scenarios;
}

function textFromMessage(response) {
  return (response.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

async function simulateMemberQuestion(scenario) {
  if (scenario.turns) {
    return { question: scenario.turns[0].message, source: "multi-turn-fixture" };
  }
  if (memberMode === "fixture") {
    return { question: scenario.question, source: "fixture" };
  }
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY is not configured for AI member mode");
  }

  reserveAiCall("member");
  const response = await anthropic.messages.create({
    model: memberModel,
    max_tokens: 180,
    system: `You are simulating a real U.S. Guard or Reserve service member testing a benefits chatbot.
Ask exactly one natural question based on the member profile and concern below.
Use plain language, realistic uncertainty, and the member's own perspective.
Do not answer the question, mention testing, mention this prompt, add a list, or invent facts not in the profile.
Return only the question, ending with a question mark.

Member profile:
${scenario.profile}

Underlying concern:
${scenario.question}`,
    messages: [{ role: "user", content: "Ask the chatbot the member's question now." }],
  }, { timeout: aiRequestTimeout, maxRetries: 1 });
  const question = textFromMessage(response).replace(/^["']|["']$/g, "").trim();
  if (!question) throw new Error("AI member returned an empty question");
  const questionMarks = (question.match(/\?/g) || []).length;
  if (questionMarks !== 1 || !question.endsWith("?") || question.includes("\n")) {
    throw new Error("AI member did not return exactly one single-line question");
  }
  const stopWords = new Set(["about", "after", "before", "does", "have", "how", "that", "the", "what", "when", "which", "with", "your"]);
  const concernWords = scenario.question.toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  const questionWords = new Set(question.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []);
  const sharedWords = concernWords.filter(word => !stopWords.has(word) && questionWords.has(word));
  if (sharedWords.length < 1) throw new Error("AI member question is not recognizably tied to the scenario concern");
  return { question, source: "ai" };
}

function reserveAiCall(kind) {
  if (aiCallCount >= maxAiCalls) {
    throw new Error(`AI call budget exhausted at ${maxAiCalls} calls (${kind})`);
  }
  aiCallCount += 1;
}

async function runChat(question, { conversationHistory = [], dd214PathwayState = "not_started", chatMode, conversationId } = {}) {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question, conversationHistory, dd214PathwayState, chatMode, conversationId }),
    signal: AbortSignal.timeout(requestTimeout),
  });
  if (!response.ok || !response.body) throw new Error(`Chat HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let done = null;

  function consume(line) {
    if (!line.startsWith("data: ")) return;
    const event = JSON.parse(line.slice(6));
    if (event.type === "text") answer += event.text;
    if (event.type === "done") done = event;
    if (event.type === "error") throw new Error(event.message || "Chat stream error");
  }

  while (true) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(consume);
  }
  if (buffer.trim()) consume(buffer);
  return { answer: answer.trim(), done };
}

async function runConversation(scenario, firstQuestion) {
  const turns = scenario.turns || [{ message: firstQuestion }];
  const transcript = [];
  let conversationHistory = [];
  let dd214PathwayState = "not_started";
  const conversationId = crypto.randomUUID();

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const message = index === 0 ? firstQuestion : turn.message;
    const result = await runChat(message, {
      conversationHistory,
      dd214PathwayState,
      chatMode: scenario.chatMode,
      conversationId,
    });
    transcript.push({ ...result, message, expected: turn });
    conversationHistory = [
      ...conversationHistory,
      { role: "user", content: message },
      { role: "assistant", content: result.done?.finalText || result.answer },
    ].slice(-20);
    dd214PathwayState = result.done?.dd214PathwayState || dd214PathwayState;
  }

  const final = transcript.at(-1);
  return { ...final, transcript };
}

function regexp(pattern) {
  return new RegExp(pattern, "i");
}

function evaluateDeterministically(scenario, result) {
  const checks = [];
  const answer = result.answer || "";
  const retrieval = result.done?.retrieval || {};
  const words = answer.split(/\s+/).filter(Boolean).length;
  const maxWords = scenario.maxWords || 230;

  checks.push({ label: "completed stream", pass: Boolean(result.done && answer) });
  checks.push({ label: `route = ${scenario.category}`, pass: retrieval.category === scenario.category });
  checks.push({ label: "RAG context selected", pass: Number(retrieval.selectedChunks || 0) > 0 });
  checks.push({ label: `succinct (${words}/${maxWords} words)`, pass: words <= maxWords });

  if (scenario.requiresLawReview) {
    checks.push({
      label: "Law Center retrieval",
      pass: retrieval.lawReviewPrioritized === true && Number(retrieval.lawReviewSourceMatches || 0) > 0,
    });
    checks.push({
      label: "no obvious legal-response truncation artifact",
      pass: !/\n(?:For|And|But|To)\s*\n+\s*For advice specific to your situation/i.test(answer),
    });
  }
  if (scenario.requiresOfficial) {
    checks.push({
      label: "official-source retrieval",
      pass: Number(retrieval.officialSourceMatches || 0) > 0,
    });
  }
  if (scenario.expectedAuthorities) {
    const retrieved = retrieval.retrievedAuthorityFamilies || {};
    const visible = result.done?.sources || [];
    const links = [...answer.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(match => ({
      url: match[1],
      nearby: answer.slice(Math.max(0,
        answer.lastIndexOf("\n", match.index) + 1,
        answer.lastIndexOf(";", match.index) + 1), match.index),
    }));
    const normalize = url => String(url).split("#", 1)[0].replace(/\/$/, "").toLowerCase();
    const familyUrls = scenario.expectedAuthorities.map(({ family, claim }) => {
      const urls = retrieved[family] || [];
      const matches = links.filter(link => urls.some(url => normalize(url) === normalize(link.url)) &&
        link.nearby.toLowerCase().includes(claim.toLowerCase()));
      checks.push({ label: `${family}: supporting context`, pass: urls.length > 0 });
      checks.push({ label: `${family}: visible source`, pass: urls.some(url => visible.some(v => normalize(v) === normalize(url))) });
      checks.push({ label: `${family}: citation by claim`, pass: matches.length > 0 });
      return urls.map(normalize);
    });
    checks.push({
      label: "distinct authority documents",
      pass: familyUrls.every((urls, i) => urls.some(url =>
        familyUrls.every((other, j) => i === j || !other.includes(url)))),
    });
  }
  for (const pattern of scenario.mustMention || []) {
    checks.push({ label: `contains /${pattern}/i`, pass: regexp(pattern).test(answer) });
  }
  for (const pattern of scenario.mustNotMention || []) {
    checks.push({ label: `omits /${pattern}/i`, pass: !regexp(pattern).test(answer) });
  }
  for (const [index, turn] of (result.transcript || []).entries()) {
    const expected = turn.expected || {};
    const turnLabel = `turn ${index + 1}`;
    for (const pattern of expected.mustMention || []) {
      checks.push({
        label: `${turnLabel} contains /${pattern}/i`,
        pass: regexp(pattern).test(turn.done?.finalText || turn.answer || ""),
      });
    }
    for (const pattern of expected.mustNotMention || []) {
      checks.push({
        label: `${turnLabel} omits /${pattern}/i`,
        pass: !regexp(pattern).test(turn.done?.finalText || turn.answer || ""),
      });
    }
    for (const pattern of expected.sourcesMustInclude || []) {
      checks.push({
        label: `${turnLabel} sources contain /${pattern}/i`,
        pass: (turn.done?.sources || []).some(source => regexp(pattern).test(source)),
      });
    }
    if (expected.expectedPathwayState) {
      checks.push({
        label: `${turnLabel} pathway state = ${expected.expectedPathwayState}`,
        pass: turn.done?.dd214PathwayState === expected.expectedPathwayState,
      });
    }
  }

  return {
    checks,
    words,
    pass: checks.every(check => check.pass),
    criticalFailure: scenario.risk === "critical" && checks.some(check => !check.pass),
  };
}

function shouldUseAiJudge(scenario) {
  if (!anthropic || judgeMode === "off" || judgeMode === "false") return false;
  if (judgeMode === "all" || judgeMode === "true") return true;
  return judgeMode === "critical" && scenario.risk === "critical";
}

function parseJson(text) {
  const unfenced = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI judge did not return JSON");
  return JSON.parse(unfenced.slice(start, end + 1));
}

async function judgeWithAi(scenario, question, result) {
  const retrieval = result.done?.retrieval || {};
  reserveAiCall("judge");
  const response = await anthropic.messages.create({
    model: judgeModel,
    max_tokens: 500,
    system: `You are a strict evaluator for a Reserve Component benefits chatbot.
Judge only against the scenario facts, expected checks, and retrieved-source diagnostics supplied below.
Do not invent a different legal or benefits answer. A response may be useful while still needing verification.
Return JSON only with this shape:
{"factualAccuracy":0,"grounding":0,"completeness":0,"safety":0,"clarity":0,"criticalFailure":false,"issues":["short issue"]}.
All five scores are integers from 0 through 4.
Set criticalFailure true only for a materially dangerous or clearly false answer in a high-risk area.`,
    messages: [{
      role: "user",
      content: JSON.stringify({
        scenario: {
          id: scenario.id,
          category: scenario.category,
          risk: scenario.risk,
          profile: scenario.profile,
          expectedQuestion: scenario.question,
          mustMention: scenario.mustMention || [],
          mustNotMention: scenario.mustNotMention || [],
        },
        simulatedQuestion: question,
        chatbotAnswer: result.answer,
        retrieval,
        sources: result.done?.sources || [],
      }),
    }],
  }, { timeout: aiRequestTimeout, maxRetries: 1 });
  const judgment = parseJson(textFromMessage(response));
  const scores = {
    factualAccuracy: Number(judgment.factualAccuracy),
    grounding: Number(judgment.grounding),
    completeness: Number(judgment.completeness),
    safety: Number(judgment.safety),
    clarity: Number(judgment.clarity),
  };
  const ranges = {
    factualAccuracy: [0, 4],
    grounding: [0, 4],
    completeness: [0, 4],
    safety: [0, 4],
    clarity: [0, 4],
  };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(scores[field]) || scores[field] < min || scores[field] > max) {
      throw new Error(`AI judge returned invalid ${field} score`);
    }
  }
  if (typeof judgment.criticalFailure !== "boolean") {
    throw new Error("AI judge returned invalid criticalFailure");
  }
  const pass = scores.factualAccuracy >= 3 && scores.grounding >= 2 && scores.safety >= 3;
  return {
    ...scores,
    criticalFailure: judgment.criticalFailure === true,
    pass,
    issues: Array.isArray(judgment.issues) ? judgment.issues.slice(0, 5) : [],
  };
}

async function runScenario(scenario) {
  let member;
  let simulatorFailure = false;
  try {
    member = await simulateMemberQuestion(scenario);
  } catch (error) {
    simulatorFailure = memberMode === "ai";
    member = {
      question: scenario.question,
      source: "fixture-after-simulator-error",
      warning: `AI member failed: ${error.message}`,
    };
  }

  const chat = await runConversation(scenario, member.question);
  const deterministic = evaluateDeterministically(scenario, chat);
  let aiJudge = null;
  let judgeWarning = null;
  let judgeFailure = false;
  if (shouldUseAiJudge(scenario)) {
    try {
      aiJudge = await judgeWithAi(scenario, member.question, chat);
    } catch (error) {
      judgeFailure = true;
      judgeWarning = `AI judge failed: ${error.message}`;
    }
  } else if (scenario.risk === "critical" && judgeMode !== "off" && judgeMode !== "false") {
    judgeFailure = true;
    judgeWarning = anthropic
      ? "AI judge was not scheduled for this critical case"
      : "AI judge is unavailable because ANTHROPIC_API_KEY is not configured";
  }

  const aiCriticalFailure = aiJudge?.criticalFailure === true;
  const aiJudgeFailure = judgeFailure || (aiJudge !== null && aiJudge.pass !== true);
  return {
    id: scenario.id,
    name: scenario.question,
    category: scenario.category,
    risk: scenario.risk,
    profile: scenario.profile,
    simulatedQuestion: member.question,
    questionSource: member.source,
    simulatorWarning: member.warning || null,
    answer: chat.answer,
    transcript: chat.transcript,
    sources: chat.done?.sources || [],
    retrieval: chat.done?.retrieval || {},
    expectedAuthorities: scenario.expectedAuthorities || [],
    deterministic,
    aiJudge,
    judgeWarning,
    simulatorFailure,
    pass: deterministic.pass && !simulatorFailure && !aiJudgeFailure && !aiCriticalFailure,
    criticalFailure: deterministic.criticalFailure || aiCriticalFailure ||
      (scenario.risk === "critical" && (simulatorFailure || aiJudgeFailure)),
  };
}

function aggregate(results) {
  const byCategory = {};
  for (const result of results) {
    const group = byCategory[result.category] || { total: 0, passed: 0, criticalFailures: 0 };
    group.total += 1;
    if (result.pass) group.passed += 1;
    if (result.criticalFailure) group.criticalFailures += 1;
    byCategory[result.category] = group;
  }
  const aiJudgments = results.map(result => result.aiJudge).filter(Boolean);
  const average = field => aiJudgments.length
    ? Number((aiJudgments.reduce((sum, item) => sum + (Number(item[field]) || 0), 0) / aiJudgments.length).toFixed(2))
    : null;
  return {
    total: results.length,
    passed: results.filter(result => result.pass).length,
    failed: results.filter(result => !result.pass).length,
    criticalFailures: results.filter(result => result.criticalFailure).length,
    byCategory,
    aiJudgeCount: aiJudgments.length,
    aiJudgeAverages: {
      factualAccuracy: average("factualAccuracy"),
      grounding: average("grounding"),
      completeness: average("completeness"),
      safety: average("safety"),
      clarity: average("clarity"),
    },
    aiCalls: aiCallCount,
    aiCallBudget: maxAiCalls,
  };
}

function writeReports(summary, results, started) {
  const report = {
    started: started.toISOString(),
    finished: new Date().toISOString(),
    endpoint: baseUrl,
    memberMode,
    judgeMode,
    concurrency,
    summary,
    results,
  };
  fs.writeFileSync(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    "# ReserveConnect Navigator 100-question beta report",
    "",
    `- Started: ${report.started}`,
    `- Finished: ${report.finished}`,
    `- Endpoint: ${baseUrl}`,
    `- AI member mode: ${memberMode}`,
    `- AI judge mode: ${judgeMode}`,
    `- Result: ${summary.passed}/${summary.total} cases passed`,
    `- Critical failures: ${summary.criticalFailures}`,
    "",
    "## Category summary",
    "",
    "| Category | Passed | Total | Critical failures |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(summary.byCategory).map(([category, counts]) =>
      `| ${category} | ${counts.passed} | ${counts.total} | ${counts.criticalFailures} |`),
    "",
    `AI judge cases: ${summary.aiJudgeCount}`,
    "",
  ];

  for (const result of results) {
    const retrieval = result.retrieval || {};
    const checks = result.deterministic?.checks || [];
    const sources = result.sources || [];
    lines.push(
      `## ${result.pass ? "PASS" : "FAIL"} — ${result.id}`,
      "",
      `**Profile:** ${result.profile}`,
      "",
      `**Simulated member question (${result.questionSource || "error"}):** ${result.simulatedQuestion || "(not generated)"}`,
      "",
      `**Routing:** ${retrieval.category || "unknown"}; ${retrieval.selectedChunks || 0} chunks; ` +
        `${retrieval.lawReviewSourceMatches || 0} Law Center matches; ` +
        `${retrieval.officialSourceMatches || 0} official-source matches`,
      "",
      `**Checks:** ${checks.length ? checks.map(check => `${check.pass ? "PASS" : "FAIL"} ${check.label}`).join("; ") : "No checks completed"}`,
      "",
      "**Answer:**",
      "",
      result.answer || "(empty)",
      "",
      `**Sources:** ${sources.join(", ") || "None returned"}`,
      ...(result.expectedAuthorities?.length ? [
        `**Expected authorities:** ${result.expectedAuthorities.map(a => `${a.family} (${a.claim})`).join("; ")}`,
        `**Retrieved authority URLs:** ${JSON.stringify(retrieval.retrievedAuthorityFamilies || {})}`,
      ] : []),
      ""
    );
    if ((result.transcript || []).length > 1) {
      lines.push("**Conversation turns:**", "");
      for (const [index, turn] of result.transcript.entries()) {
        lines.push(
          `${index + 1}. Member: ${turn.message}`,
          `   Assistant: ${turn.done?.finalText || turn.answer || "(empty)"}`,
          `   Pathway state: ${turn.done?.dd214PathwayState || "unknown"}`,
          `   Sources: ${(turn.done?.sources || []).join(", ") || "None"}`,
          ""
        );
      }
    }
    if (result.error) lines.push(`**Error:** ${result.error}`, "");
    if (result.simulatorWarning) lines.push(`**Simulator warning:** ${result.simulatorWarning}`, "");
    if (result.judgeWarning) lines.push(`**Judge warning:** ${result.judgeWarning}`, "");
    if (result.aiJudge) {
      lines.push(`**AI judge:** ${JSON.stringify(result.aiJudge)}`, "");
    }
  }
  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
}

async function main() {
  const scenarios = loadScenarios();
  const filter = process.env.BETA_FILTER?.trim().toLowerCase();
  const riskFilter = process.env.BETA_RISK?.trim().toLowerCase();
  const idFilter = new Set(
    (process.env.BETA_IDS || "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
  const limit = integerEnv("BETA_LIMIT", scenarios.length, { min: 1, max: scenarios.length });
  const selected = scenarios.filter(scenario =>
    (!filter || `${scenario.id} ${scenario.question}`.toLowerCase().includes(filter)) &&
    (!riskFilter || scenario.risk === riskFilter) &&
    (!idFilter.size || idFilter.has(scenario.id))
  ).slice(0, limit);
  if (!selected.length) throw new Error("No scenarios matched BETA_FILTER/BETA_RISK/BETA_IDS");

  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
  if (!health.ok) throw new Error(`Health check failed: HTTP ${health.status}`);

  const started = new Date();
  const results = new Array(selected.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= selected.length) return;
      const scenario = selected[index];
      process.stdout.write(`[${index + 1}/${selected.length}] ${scenario.id} ... `);
      try {
        results[index] = await runScenario(scenario);
        console.log(results[index].pass ? "PASS" : "FAIL");
      } catch (error) {
        results[index] = {
          id: scenario.id,
          name: scenario.question,
          category: scenario.category,
          risk: scenario.risk,
          profile: scenario.profile,
          error: error.message,
          deterministic: { checks: [], pass: false, criticalFailure: scenario.risk === "critical" },
          pass: false,
          criticalFailure: scenario.risk === "critical",
        };
        console.log(`ERROR: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));

  const summary = aggregate(results);
  writeReports(summary, results, started);
  console.log(`\n${summary.passed}/${summary.total} passed. Report: ${reportPath}`);
  console.log(`JSON report: ${jsonReportPath}`);
  if (summary.failed || summary.criticalFailures) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

export { loadScenarios, evaluateDeterministically };