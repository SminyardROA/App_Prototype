import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPort = process.env.BETA_PORT || process.env.PORT || "3000";
const baseUrl = process.env.BETA_BASE_URL || `http://127.0.0.1:${defaultPort}`;
const reportPath = path.join(__dirname, "beta-test-report.md");

const cases = [
  {
    name: "Quick action — transition",
    question: "I'm transitioning out of the Guard/Reserve. What should I do next?",
    category: "benefits",
  },
  {
    name: "Quick action — legal",
    question: "I have a question about law (employment/reemployment, UCMJ, etc)",
    category: "legal",
    requireLawReview: true,
  },
  {
    name: "Quick action — VA disability",
    question: "I'm in the Guard/Reserve and have VA disability questions.",
    category: "benefits",
  },
  {
    name: "Quick action — pay intake",
    question: "My pay is a mess. Help!",
    category: "pay",
  },
  {
    name: "Quick action — special compensation",
    question: "I need help with special pay and compensation (BAH, BAS, travel pay, special duty pay);",
    category: "pay",
  },
  {
    name: "Quick action — veteran benefits",
    question: "I'm a Guard/Reserve veteran. What benefits do I qualify for?",
    category: "benefits",
  },
  {
    name: "USERRA reemployment",
    question: "My civilian employer says my position was eliminated while I was mobilized. What reemployment protections should I check under USERRA?",
    category: "legal",
    requireLawReview: true,
    mustMention: [/(reemploy|escalator|seniority|comparable position)/i, /(jag|attorney|claims agent)/i],
  },
  {
    name: "UCMJ jurisdiction",
    question: "Can a drilling reservist be subject to the UCMJ for conduct between drill periods?",
    category: "legal",
    requireLawReview: true,
    mustMention: [/(duty status|jurisdiction|orders)/i, /(jag|attorney|claims agent)/i],
  },
  {
    name: "VA compensation and drill pay",
    question: "Can I receive VA disability compensation and drill pay in the same year?",
    category: "benefits",
    mustMention: [/(same days|days served|per-day|waive)/i],
  },
  {
    name: "Reduced-age retirement and TRICARE",
    question: "If my Reserve retired pay starts at age 55 because of qualifying active service, do I also get regular retiree TRICARE at 55?",
    category: "benefits",
    mustMention: [/age 60/i, /(TRR|TRICARE Retired Reserve)/i],
  },
  {
    name: "Post-9/11 GI Bill eligibility",
    question: "I have six years of drilling-only Selected Reserve service. Does that by itself qualify me for the Post-9/11 GI Bill?",
    category: "benefits",
    mustMention: [/(active duty|qualifying active service)/i, /(does not|not by itself|no)/i],
  },
  {
    name: "Education benefit transfer after separation",
    question: "I already separated from the Reserve. Can I now transfer my unused Post-9/11 GI Bill benefits to my child?",
    category: "benefits",
    mustMention: [/(while still serving|before separation|cannot transfer after|must.*serving)/i],
  },
  {
    name: "IDT travel reimbursement",
    question: "I drive 220 miles each way for drill. Is my travel automatically reimbursed?",
    category: "pay",
    mustMention: [/(not automatic|not automatically|generally not|limited exception|eligib)/i],
  },
  {
    name: "BAH on long Reserve orders",
    question: "I'm an E-5 reservist going on 180-day orders away from home. Which BAH rules determine what I receive?",
    category: "pay",
    mustMention: [/(orders|duty status|PDS|TDY)/i, /(dependent|location|locality)/i],
  },
  {
    name: "CRDP versus CRSC",
    question: "Are CRDP and CRSC the same benefit, and can I receive both at the same time?",
    category: "benefits",
    mustMention: [/(different|not the same)/i, /(cannot|not.*both|one at a time)/i],
  },
  {
    name: "LGBTQ separation protections",
    question: "I'm in the Air National Guard and believe I am being separated because I am transgender. What legal protections and review options should I consider?",
    category: "legal",
    requireLawReview: true,
    mustMention: [/(jag|attorney|claims agent)/i, /(DoD|instruction|separation)/i],
  },
  // Final-answer referral enforcement: use focused BETA_FILTER="Resource referral"
  // to exercise the complete streamed response without running the whole suite.
  {
    name: "Resource referral — LGBTQ military support",
    question: "As a queer reservist, where can I find support from LGBTQ military organizations?",
    category: "general",
    mustAppearOnce: ["https://spartapride.org/", "https://www.outinnationalsecurity.org/"],
  },
  {
    name: "Resource referral — LGBTQ separation and legal help",
    question: "I'm transgender and facing adverse action because of my gender identity in the Guard. What legal rights and review options should I ask about?",
    category: "legal",
    mustMention: [/JAG/i, /DoD instruction/i, /service.{0,20}regulation/i, /Reserve Service Law Center/i],
    mustAppearOnce: ["https://spartapride.org/", "https://www.outinnationalsecurity.org/", "[LAW_CENTER_BANNER]"],
  },
  {
    name: "Resource referral — no LGBTQ organizations for unrelated legal issues",
    question: "What are my USERRA rights if my employer fired me after military leave?",
    category: "legal",
    mustNotMention: [/spartapride\.org/i, /outinnationalsecurity\.org/i],
  },
  {
    name: "Resource referral — flexible gig work",
    question: "Where can a reservist find flexible gig work around drill weekends?",
    category: "general",
    mustMention: [/GigEagle/i],
    mustAppearOnce: ["https://gigeagle.mil/"],
  },
  {
    name: "Resource referral — no GigEagle for a workplace dispute",
    question: "What are my legal rights if my employer denied military leave?",
    category: "legal",
    mustNotMention: [/gigeagle\.mil/i],
  },
  {
    name: "Resource referral — education benefits",
    question: "Where can I find GI Bill education benefits and scholarships as a reservist?",
    category: "benefits",
    mustMention: [/ReserveEducation/i],
    mustAppearOnce: ["https://roa.org/reserveeducation/"],
  },
  {
    name: "Resource referral — no education link for insurance",
    question: "What health insurance benefits can a drilling reservist get?",
    category: "benefits",
    mustNotMention: [/roa\.org\/reserveeducation/i],
  },
  {
    name: "Resource referral — ReserveCare and TRICARE",
    question: "What TRICARE health insurance coverage can I get as a drilling reservist?",
    category: "benefits",
    mustMention: [/Are you aware of ROA-sponsored insurance plans/i, /TRICARE/i],
    mustAppearOnce: ["https://www.roainsure.com"],
  },
  {
    name: "Resource referral — no ReserveCare for education",
    question: "What GI Bill education benefits can a drilling reservist use?",
    category: "benefits",
    mustNotMention: [/roainsure\.com/i],
  },
  {
    name: "Resource referral — overlapping LGBTQ legal, gig, education, and health needs",
    question: "I'm transgender and facing adverse action over my gender identity in the Guard. I need legal rights help, flexible gig work, GI Bill education benefits, and health insurance coverage. Where should I start?",
    category: "legal",
    maxWords: 360,
    mustMention: [/JAG/i, /DoD instruction/i, /service.{0,20}regulation/i],
    mustAppearOnce: [
      "https://spartapride.org/", "https://www.outinnationalsecurity.org/",
      "[LAW_CENTER_BANNER]", "https://gigeagle.mil/",
      "https://roa.org/reserveeducation/", "https://www.roainsure.com",
    ],
  },
];

async function runChat(question) {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question, conversationHistory: [], conversationId: crypto.randomUUID() }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

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
    if (event.type === "error") throw new Error(event.message || "stream error");
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
  return { answer: (done?.finalText || answer).trim(), done };
}

function evaluate(test, result) {
  const checks = [];
  const words = result.answer.split(/\s+/).filter(Boolean).length;
  const retrieval = result.done?.retrieval || {};

  checks.push({ label: "completed stream", pass: Boolean(result.done && result.answer) });
  checks.push({ label: `succinct (${words} words)`, pass: words <= (test.maxWords || 230) });
  checks.push({
    label: `route = ${test.category}`,
    pass: retrieval.category === test.category,
  });
  checks.push({
    label: "RAG context selected",
    pass: Number(retrieval.selectedChunks || 0) > 0,
  });

  if (test.requireLawReview) {
    checks.push({
      label: "Law Center retrieval prioritized",
      pass: retrieval.lawReviewPrioritized === true,
    });
    checks.push({
      label: "Law Center article matched",
      pass: Number(retrieval.lawReviewSourceMatches || 0) > 0,
    });
  }

  for (const pattern of test.mustMention || []) {
    checks.push({
      label: `contains ${pattern}`,
      pass: pattern.test(result.answer),
    });
  }
  for (const pattern of test.mustNotMention || []) {
    checks.push({
      label: `omits ${pattern}`,
      pass: !pattern.test(result.answer),
    });
  }
  for (const text of test.mustAppearOnce || []) {
    const occurrences = result.answer.split(text).length - 1;
    checks.push({
      label: `contains ${text} exactly once (${occurrences} found)`,
      pass: occurrences === 1,
    });
  }

  return { checks, words, pass: checks.every(check => check.pass) };
}

async function main() {
  const started = new Date();
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
  if (!health.ok) throw new Error(`Health check failed: HTTP ${health.status}`);

  const filter = process.env.BETA_FILTER?.trim().toLowerCase();
  const selectedCases = filter
    ? cases.filter(test => test.name.toLowerCase().includes(filter))
    : cases;
  if (selectedCases.length === 0) throw new Error(`No beta cases matched BETA_FILTER="${filter}"`);

  const results = [];
  for (let index = 0; index < selectedCases.length; index += 1) {
    const test = selectedCases[index];
    process.stdout.write(`[${index + 1}/${selectedCases.length}] ${test.name} ... `);
    try {
      const result = await runChat(test.question);
      const evaluation = evaluate(test, result);
      results.push({ test, result, evaluation });
      console.log(evaluation.pass ? "PASS" : "FAIL");
    } catch (error) {
      results.push({ test, error: error.message, evaluation: { pass: false, checks: [], words: 0 } });
      console.log(`ERROR: ${error.message}`);
    }
  }

  const passed = results.filter(item => item.evaluation.pass).length;
  const lines = [
    "# ReserveConnect Navigator beta-test report",
    "",
    `- Started: ${started.toISOString()}`,
    `- Endpoint: ${baseUrl}`,
    `- Result: ${passed}/${results.length} cases passed all automated checks`,
    "",
  ];

  for (const item of results) {
    lines.push(`## ${item.evaluation.pass ? "PASS" : "FAIL"} — ${item.test.name}`, "");
    lines.push(`**Question:** ${item.test.question}`, "");
    if (item.error) {
      lines.push(`**Error:** ${item.error}`, "");
      continue;
    }
    const retrieval = item.result.done?.retrieval || {};
    lines.push(
      `**Routing:** ${retrieval.category || "unknown"}; ` +
      `${retrieval.selectedChunks || 0} chunks; ` +
      `${retrieval.lawReviewSourceMatches || 0} Law Center matches; ` +
      `${retrieval.officialSourceMatches || 0} official-source matches`,
      "",
      `**Checks:** ${item.evaluation.checks.map(check => `${check.pass ? "PASS" : "FAIL"} ${check.label}`).join("; ")}`,
      "",
      `**Answer (${item.evaluation.words} words):**`,
      "",
      item.result.answer,
      "",
      `**Sources:** ${(item.result.done?.sources || []).join(", ") || "None returned"}`,
      ""
    );
  }

  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
  console.log(`\n${passed}/${results.length} passed. Report: ${reportPath}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});