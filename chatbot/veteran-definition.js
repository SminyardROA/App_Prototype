import { veteranIntakeQuestion, isNumericIntakeReply } from "./veteran-intake.js";

// Verified against the existing indexed article, not inferred from its number.
export const VETERAN_DEFINITION_URL =
  "https://assets.roa.org/wp-content/uploads/2026/10/LR26074veterandefinitionNEW.pdf";

export function isVeteranDefinitionQuestion(question) {
  const text = String(question || "");
  return /\b26074\b/i.test(text) ||
    (/\bveterans?\b/i.test(text) &&
      /\b(?:definition|define|status|qualif\w*|eligib\w*|benefits?|considered|count|make|mean|prove|am I|are we|who is|who counts|what is|whether|does.*service)\b/i.test(text)) ||
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
  const unrelated = /\b(?:USERRA|SCRA|BAH|BAS|TRICARE|drill pay|civilian employer|Susan Lukas|Pentagon|shoulder rating)\b/i;
  // A short intake answer ("90 days", "No", "I have a DD214") must keep
  // researching the definition. Stop at a different subject or beneficiary.
  const newSubject = /\b(?:my (?:friend|buddy|wife|husband|father|mother|son|daughter)|someone else|change (?:the )?topic|never mind)\b/i;
  if (unrelated.test(latest) || newSubject.test(latest)) return latest;
  const relevantAnswer = /^(?:\d+\b|[A-D][).]?$|no\b|yes\b|none\b|not sure\b|only\b|about\b|approximately\b|six years\b|twenty years\b|I['’]m\b|I (?:have|don't|do not|did|haven't|never|only|completed|served|was|am)\b|my (?:DD|discharge|orders|rating)\b|honorable\b|general\b|Title\b|Selected Reserve\b|drill\b|annual training\b|active duty\b|home loan\b|VA home loan\b|education\b|health care\b|burial\b|pension\b|disability\b)/i;
  const followUp = /^(?:what|how|why|can|could|does|do|is|are|and|also|yes|no|I served|I was|honorable|general discharge|other than honorable|Title 10|Title 32|disability|compensation|education|health care|burial|pension)\b/i;
  if (!followUp.test(latest) && !relevantAnswer.test(latest) &&
      !isNumericIntakeReply(latest) && !/^(?:days?|weeks?|months?|years?)[.!]?$/i.test(latest)) return latest;
  for (const turn of history.slice(-12).reverse()) {
    if (typeof turn?.content !== "string") continue;
    if (turn.role === "assistant" && turn.content.includes(VETERAN_DEFINITION_URL)) {
      return `Veteran status / benefit eligibility follow-up (Law Review 26074): ${latest}`;
    }
    if (turn.role !== "user") continue;
    if (unrelated.test(turn.content) || newSubject.test(turn.content)) break;
    if (isVeteranDefinitionQuestion(turn.content)) return `Veteran status / benefit eligibility follow-up (Law Review 26074): ${latest}`;
    if (!followUp.test(turn.content.trim()) && !relevantAnswer.test(turn.content.trim()) &&
        !isNumericIntakeReply(turn.content) && !/^(?:days?|weeks?|months?|years?)[.!]?$/i.test(turn.content.trim())) break;
  }
  return latest;
}

export function veteranGuidanceInstruction(question, documents = [], history = []) {
  if (!isVeteranDefinitionQuestion(question)) return "";
  const available = documents.some(document =>
    document.url === VETERAN_DEFINITION_URL && document.text?.trim());
  const intakeComplete = !veteranIntakeQuestion(question, history) &&
    !/\b(?:my (?:friend|buddy|wife|husband|father|mother|son|daughter)|someone else|hypothetically)\b/i.test(question);
  return `\n\nVETERAN STATUS GUIDED RESEARCH:
${intakeComplete ? "SERVICE INTAKE TOPICS ALREADY ADDRESSED: The member has addressed the relevant duty/duration, discharge, records, training-disability and Selected Reserve questions (or the topics did not apply). Do not repeat or ask them to reconfirm these answers. Read their actual answers in history; addressed does NOT mean eligible, verified or affirmative. Give the supported benefit-specific research or identify an actually unresolved program requirement instead." : ""}
${available
    ? "Use ROA Law Review 26074 as a preferred explanatory reference alongside ALL relevant supplied RAG sources. Prefer applicable statutes, CFR provisions and official VA guidance for the specific legal or benefit rule. The article is not the only authority."
    : "Answer using ALL relevant supplied RAG sources, including statutes, CFR provisions, official VA guidance and other articles. No single article is required to explain a supported rule. Cite only sources whose actual supplied text supports it; do not invent an article's contents or attribution."}
USER-FACING ANSWER: Answer the user's question, not the search process. Never narrate what could or could not be retrieved, which article was missing, what is indexed, or a list of retrieval limitations. Do not use phrases such as "not retrieved this turn" or "these retrieved passages." When the evidence supports only part of the answer, explain that useful part and ask about the specific remaining service fact or benefit requirement. If a rule cannot be established, say only what needs confirmation (for example, the duty authority on their orders), without guessing or making a blanket denial.
Help the user work out possible Veteran-status routes AND specific benefit routes, not a blanket yes/no or a demand that they first name a benefit. Keep each turn concise: explain the relevant sourced distinction, then ask ONE next genuinely missing question. Use all facts already volunteered in this conversation, accept corrections, and do not repeat answered questions. Do not treat a question, hypothetical, or someone else's facts as the user's service.
Use this adaptive sequence, skipping known or irrelevant items:
1. Type/purpose of duty (active duty other than training, ADT/annual training, IDT/drill, federal versus state National Guard duty) and approximate duration. Dates/order authority may need clarification for the selected benefit. Do not impose a universal 180-day or 24-month definition.
2. Discharge/release characterization for the relevant service period. Whenever asking about characterization of service, include "(Honorable, Under Honorable Conditions, etc.)" immediately after that term. Ask if the user has a DD Form 214 (and DD214-1 if relevant), or another service record, without asking them to upload it or disclose identifying details. A DD214 is evidence, not by itself proof of qualifying duty or benefit eligibility; not having one is not an automatic denial. This is different from the one-time DD214-1 awareness invitation; do not restart that invitation.
3. If training or drill is relevant, ask whether an injury/disease was incurred or aggravated in line of duty, and whether VA has recognized a service-connected disability for that period (including any rating). Do not require an existing rating before someone can seek a claim. ADT and IDT have different rules: read their actual supplied passages; do not collapse disease/injury and IDT's listed acute cardiac/cerebrovascular events into one rule. A unit LOD finding is evidence, not automatically VA's determination.
4. Ask about completed years in the Selected Reserve (not simply years since enlistment or IRR time), current service/discharge/transfer status, and qualifying retirement service when relevant. Explain the six-year Selected Reserve home-loan route ONLY when supplied passages support it. Six calendar years of any Reserve service do not automatically establish eligibility; explain supported additional conditions or ask what remains unverified. Do not deny a home-loan route just because the user may not meet the general Title 38 Veteran definition.
5. Once enough facts are known, summarize the supported potential status and benefit routes, remaining uncertainties, and ask which benefit to explore next (compensation, home loan, education, health care, burial, employment or state benefits). Research its separate rules using the full member RAG. Do not give an exhaustive checklist every turn or promise approval. Distinguish honorary Veteran recognition after qualifying Reserve retirement from entitlement to a benefit.
Only cite passages actually supplied. A source link is not proof of a personal eligibility determination. VA makes benefit decisions; when records or criteria are uncertain, say exactly what needs confirmation rather than declaring the user ineligible for all benefits. Do not add a records system, document-request procedure, or other practical step unless a supplied passage supports it.
VETERAN GUIDANCE RESPONSE LENGTH OVERRIDE: Keep this turn to 120–170 words, including citations, with at most two short explanatory points and ONE focused next question. Do not recite the full intake sequence or re-list the user's entire history. If the user has already supplied all needed facts, give a concise supported summary and a next step rather than asking again. This length instruction also applies when DD214, disability, or a home loan is mentioned.`;
}

export function veteranBenefitClarification(question, documents = [], history = []) {
  if (!isVeteranDefinitionQuestion(question)) return null;
  // Explain a conceptual/records question before collecting personal service
  // facts. Intake must not replace the answer to "Does a DD214 prove status?"
  if (/\b(?:definition|define|statutory|does\b.*(?:mean|make|prove)|is\b.*(?:enough|proof))\b/i.test(question)) return null;
  const articleAvailable = documents.some(document =>
    document.url === VETERAN_DEFINITION_URL && document.text?.trim());
  const intakeIntro = articleAvailable
    ? `Let's use [Law Review 26074](${VETERAN_DEFINITION_URL}) alongside the relevant benefit rules to check your service history.`
    : "Let's work through your service history and the benefit you want help with.";
  // Intake questions contain no eligibility determination. Once the fields
  // have been addressed, generation researches the actual benefit criteria.
  if (/Veteran status \/ benefit eligibility follow-up/i.test(question) ||
      history.some(turn => turn?.role === "assistant" &&
        String(turn.content || "").includes(VETERAN_DEFINITION_URL))) {
    const next = veteranIntakeQuestion(question, history);
    return next
      ? `${intakeIntro}\n\n${next}`
      : null;
  }
  // "VA benefits" is not a single eligibility determination. Use the member's
  // latest definition question and follow-up, not unrelated older programs.
  const precedingQuestion = [...history].reverse().find(turn =>
    turn?.role === "user" && isVeteranDefinitionQuestion(turn.content))?.content || "";
  const scope = `${question}\n${precedingQuestion}`;
  if (/\b(?:disability|compensation|pension|home loans?|GI Bill|education|health care|healthcare|burial|hiring|preference)\b/i.test(scope)) return null;
  if (!/\b(?:benefits?|eligib\w*|qualif\w*|status|am I|whether|considered|count)\b/i.test(question)) return null;
  // If the opening already contains service facts, use the adaptive guidance
  // rather than a fixed first question that might ask for them again.
  if (/\b(?:\d+|DD\s*(?:Form\s*)?214|Title\s*(?:10|32)|honorable|discharge|active duty|annual training|drill|line of duty|rating)\b/i.test(
    question.replace(/\b26074\b/g, ""))) {
    const next = veteranIntakeQuestion(question, history);
    return next ? `${intakeIntro}\n\n${next}` : null;
  }
  const opening = articleAvailable
    ? `We can work through this together using [ROA Law Review 26074 — Who Is a “Veteran”?](${VETERAN_DEFINITION_URL}) alongside other relevant authorities. Veteran status and eligibility for a particular benefit are separate questions, so we should check both—not assume one answer decides every benefit.`
    : "I can help you work through your service history and look into benefits that may apply.";
  return `${opening}\n\nFirst, what kind of duty have you performed: active duty other than training, annual training/other active duty for training, drill weekends, or a combination—and roughly how long on active duty, if any?\n\nYou don't need to share personal identifying information or upload records. I'll use facts you've already shared and ask only for missing details.`;
}
