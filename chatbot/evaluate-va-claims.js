// Explicit opt-in paid evaluation using synthetic facts only. Never log prompts,
// source text, answers or SDK exceptions. Normal npm tests do not call providers.
import Anthropic from "@anthropic-ai/sdk";
import { claimCases } from "./va-claim-cases.js";
import { validateVaAnswer } from "./va-claim-validation.js";

if (!process.argv.includes("--live")) {
  console.error("Run with --live to make paid source-audit calls using synthetic cases.");
  process.exitCode = 1;
} else {
  const client = new Anthropic();
  const results = [];
  const url = "https://www.va.gov/synthetic-evaluation";
  for (const item of claimCases) {
    const checked = await validateVaAnswer({
      answer: `${item.wrong} [source](${url})`,
      question: item.question || (claimCases.indexOf(item) >= 7
        ? "Suggest a few member resources." : "Evaluate this synthetic VA benefit statement."),
      documents: [{ url, text: item.passage }], model: "claude-sonnet-5",
      requireEvidence: false,
      create: (...args) => client.messages.create(...args),
    });
    results.push({ case: item.name, status: checked.status, ...checked.metrics });
  }
  const positive = await validateVaAnswer({
    answer: `Honorary veteran recognition creates no entitlement to VA benefits [source](${url}).`,
    question: "What does honorary recognition establish?", documents: [{ url, text: claimCases[2].passage }],
    model: "claude-sonnet-5", create: (...args) => client.messages.create(...args),
  });
  results.push({ case: "supported recognition statement", status: positive.status, ...positive.metrics });
  console.log(JSON.stringify(results, null, 2));
  if (results.slice(0, -1).some(result => result.status !== "unsupported") || positive.status !== "verified") {
    process.exitCode = 1;
  }
}
