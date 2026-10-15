// Verified against the existing indexed article, not inferred from its number.
export const VETERAN_DEFINITION_URL =
  "https://assets.roa.org/wp-content/uploads/2026/10/LR26074veterandefinitionNEW.pdf";

export function isVeteranDefinitionQuestion(question) {
  const text = String(question || "");
  return /\b26074\b/i.test(text) ||
    (/\bveterans?\b/i.test(text) &&
      /\b(?:definition|define|status|qualif\w*|eligib\w*|benefits?|considered|count|am I|are we|who is|who counts|what is|does.*service)\b/i.test(text)) ||
    (/\bVA\b/i.test(text) && /\b(?:qualif\w*|eligib\w*)\b/i.test(text));
}

export function isVeteranDefinitionMatch(match) {
  return String(match?.metadata?.url || "").replace(/\/$/, "").toLowerCase() ===
    VETERAN_DEFINITION_URL.toLowerCase() &&
    typeof match?.metadata?.text === "string" && match.metadata.text.trim().length > 0;
}

export function contextualVeteranQuestion(message, history = []) {
  const latest = String(message || "").trim();
  if (isVeteranDefinitionQuestion(latest)) return latest;
  const unrelated = /\b(?:USERRA|SCRA|BAH|BAS|TRICARE|GI Bill|home loans?|drill pay|civilian employer)\b/i;
  const followUp = /^(?:what|how|why|can|could|does|do|is|are|and|also|yes|no|I served|I was|honorable|general discharge|other than honorable|Title 10|Title 32|disability|compensation|education|health care|burial|pension)\b/i;
  if (unrelated.test(latest) || !followUp.test(latest)) return latest;
  for (const turn of [...history].reverse()) {
    if (turn?.role !== "user" || typeof turn.content !== "string") continue;
    if (unrelated.test(turn.content)) break;
    if (isVeteranDefinitionQuestion(turn.content)) return `Veteran status / benefit eligibility follow-up: ${latest}`;
    if (!followUp.test(turn.content.trim())) break;
  }
  return latest;
}

export function veteranBenefitClarification(question, documents = [], history = []) {
  if (!isVeteranDefinitionQuestion(question) ||
      !documents.some(document => document.url === VETERAN_DEFINITION_URL && document.text?.trim())) return null;
  // "VA benefits" is not a single eligibility determination. Use the member's
  // latest definition question and follow-up, not unrelated older programs.
  const precedingQuestion = [...history].reverse().find(turn =>
    turn?.role === "user" && isVeteranDefinitionQuestion(turn.content))?.content || "";
  const scope = `${question}\n${precedingQuestion}`;
  if (/\b(?:disability|compensation|pension|home loans?|GI Bill|education|health care|healthcare|burial|hiring|preference)\b/i.test(scope)) return null;
  if (!/\b(?:benefits?|eligib\w*|qualif\w*|status|am I|considered|count)\b/i.test(question)) return null;
  return `There isn't one “veteran” definition that determines eligibility for every benefit. [ROA Law Review 26074 — Who Is a “Veteran”?](${VETERAN_DEFINITION_URL}) explains the different definitions and why veteran status and eligibility for a particular benefit must be considered separately.\n\nWhich benefit or purpose do you mean: disability compensation, a VA home loan, education, health care, burial benefits, or something else?\n\nI'll use the service and discharge facts you've already shared, without asking you to repeat them, and look for sources covering that specific benefit. I won't treat years in the Reserve alone as proof that you qualify—or don't qualify—for all VA benefits.`;
}
