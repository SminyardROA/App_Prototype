import { SHOULDER_TOPIC } from "./shoulder-ratings.js";
import { cfrPart } from "./source-provenance.js";

export const LIMB_LOSS_TOPIC =
  /\b(?:amputat\w*|limb loss|anatomical loss|loss of (?:a |the )?(?:limb|arm|hand|leg|foot)|lost (?:a|an|his|her|my|their|the) (?:limb|arm|hand|leg|foot))\b/i;
const REGIONS = [
  { name: "limb loss", pattern: LIMB_LOSS_TOPIC, codes: "amputations anatomical loss 5120 5125 5160 5167" },
  { name: "shoulder", pattern: SHOULDER_TOPIC, codes: "5200 5201 5202 5203" },
  { name: "knee", pattern: /\b(?:knees?|ACL|menisc\w*|patella\w*|525[6-9]|526[0-3])\b/i, codes: "5256 5257 5258 5259 5260 5261" },
  { name: "ankle", pattern: /\b(?:ankles?|527[0-4])\b/i, codes: "5270 5271" },
  { name: "hip", pattern: /\b(?:hips?|femur|thigh|525[0-5])\b/i, codes: "5250 5251 5252 5253" },
  { name: "wrist", pattern: /\b(?:wrists?|521[45])\b/i, codes: "5214 5215" },
  { name: "elbow", pattern: /\b(?:elbows?|forearm|520[5-9]|521[0-3])\b/i, codes: "5205 5206 5207" },
  { name: "spine", pattern: /\b(?:spine|lumbar|cervical|523[5-9]|524[0-3]|(?:back|neck)\s+(?:injur\w*|pain|condition|disabilit\w*|rating))\b/i, codes: "5235 5237 5242 5243" },
  { name: "foot", pattern: /\b(?:foot|feet|527[6-9]|528[0-4])\b/i, codes: "5276 5284" },
  { name: "arm", pattern: /\b(?:arms?|upper extremit\w*)\b/i, codes: "" },
  { name: "leg", pattern: /\b(?:legs?|lower extremit\w*)\b/i, codes: "" },
];
const GENERAL_INJURY = /\b(?:injur(?:y|ies|ed)|fractur(?:e|ed)|sprain(?:ed)?|musculoskeletal|joint pain|range of motion|limitation of motion)\b/i;
const INJURY_FRAMEWORK = /\b(?:injur\s*(?:y|ies)|musculoskeletal|functional loss|dominant hand|handedness|line[- ]of[- ]duty|service[- ]connect\w*)\b|\b(?:3\.303|3\.306|4\.40|4\.45|4\.59|4\.69)\b/i;

export function injuryRegions(question) {
  return REGIONS.filter(region => region.pattern.test(String(question || "")));
}

export function isInjuryResearchQuestion(question) {
  const text = String(question || "");
  const benefitPurpose = /\b(?:disability|rating|claim|compensation|benefits?|service connection)\b/i.test(text);
  if (!benefitPurpose &&
      /\b(?:treat|treatment|first aid|emergency|bleeding|doctor|ER|sue|lawsuit|civilian employer|USERRA|SCRA)\b/i.test(text)) return false;
  return GENERAL_INJURY.test(text) || injuryRegions(text).length > 0;
}

export function isCfrTitle38Source(document) {
  return cfrPart(document) !== null;
}

export function injurySearchQuery(question) {
  const regions = injuryRegions(question);
  const focused = regions.slice(0, 3).map(region => `${region.name} ${region.codes}`).join(" ");
  return `38 CFR VA injuries ${focused || "musculoskeletal"} service connection line of duty functional loss rating schedule\n${question}`;
}

// A broad introductory question does not require a guessed personal rating.
// Use the retrieved regulation passages directly when the matching framework
// and actual amputation table are present; otherwise use ordinary generation.
export function limbLossOverview(question, documents = []) {
  if (!/^\s*what about (?:limb loss|amputations?)\b/i.test(question) ||
      !LIMB_LOSS_TOPIC.test(question) || !isInjuryResearchQuestion(question) ||
      /\b(?:how much|percent|ratings?|criteria|SMC|monthly|prosthe\w*|appeal|denied|effective date)\b/i.test(question)) return null;
  const schedule = documents.find(doc => cfrPart(doc) === 4 &&
    /\bamputat\w*\b/i.test(doc.text || "") &&
    /\b(?:512[0-5]|516[0-7])\b/.test(doc.text || ""));
  const connection = documents.find(doc => cfrPart(doc) === 3 &&
    /\b3\.303\b/.test(doc.text || "") && /service connection/i.test(doc.text || ""));
  if (!schedule || !connection) return null;
  const smc = documents.find(doc => cfrPart(doc) === 3 &&
    /special monthly compensation/i.test(doc.text || "") &&
    /anatomical loss|loss of use/i.test(doc.text || ""));
  const points = [
    `A limb lost following a military injury is a potential VA disability-claim issue to research. VA still needs evidence establishing service connection; the reported injury alone does not decide the claim. [Service-connection framework](${connection.url})`,
    `The published amputation schedule distinguishes the limb and level of loss. “Lost a limb” is not enough to select a personal percentage. [Amputation rating schedule](${schedule.url})`,
  ];
  if (smc) points.push(`Special Monthly Compensation may also be relevant for qualifying anatomical loss or loss of use. It is not an automatic award just because a limb was lost. [SMC provisions](${smc.url})`);
  points.push("Which limb was lost, and at what level? An accredited VA representative can help your friend apply these rules to the evidence.");
  return points.join("\n\n");
}

export function injuryContextSearches(question) {
  if (!isInjuryResearchQuestion(question)) return [];
  const searches = [];
  if (LIMB_LOSS_TOPIC.test(question)) {
    searches.push("38 CFR 4.71a amputations arm hand leg foot anatomical loss rating schedule");
    searches.push("38 CFR 3.350 special monthly compensation anatomical loss loss of use");
  }
  const dutyOrEntitlement = /\b(?:drill|training|IDT|ADT|duty|claims?|benefits?|eligib\w*|qualif\w*|service connection)\b/i.test(question);
  const ratingOnly = /\b(?:ratings?|percentage|percent)\b/i.test(question) && !dutyOrEntitlement;
  if (!ratingOnly) {
    searches.push(LIMB_LOSS_TOPIC.test(question) && !/\b(?:Guard|Reserve|drill|IDT|ADT)\b/i.test(question)
      ? "38 CFR 3.303 military injury disease resulting in disability service connection evidence"
      : "38 CFR 3.6 3.303 Guard Reserve injuries active duty for training inactive duty training line of duty service connection");
  }
  if (injuryRegions(question).length === 0) {
    searches.push("38 CFR Part 4 sections 4.40 4.45 4.59 musculoskeletal injury functional loss painful motion evaluation");
  }
  return searches;
}

export function injuryDocumentRelevant(question, document) {
  const text = String(document?.text || "");
  const regions = injuryRegions(question);
  if (regions.some(region => region.pattern.test(text))) return true;
  if (isCfrTitle38Source(document) && INJURY_FRAMEWORK.test(text)) return true;
  // General filing and appeal procedures can support a condition-specific
  // research request without repeating the injury name in every passage.
  if (/\b(?:filing|file|claims?|appeals?|evidence)\b/i.test(question) &&
      /\b(?:filing|file|claims?|appeals?|evidence)\b/i.test(text)) return true;
  return regions.length === 0 && INJURY_FRAMEWORK.test(text);
}

export function preferInjuryRegulations(question, documents) {
  if (!isInjuryResearchQuestion(question)) return documents;
  const hasRatingTable = documents.some(document =>
    cfrPart(document) === 4 &&
    /\b[5-9]\d{3}\b/.test(document.text) && /\brating\b/i.test(document.text));
  const candidates = hasRatingTable && /\b(?:ratings?|percent(?:age)?s?)\b|%/i.test(question)
    ? documents.filter(document => isCfrTitle38Source(document) ||
        !/%|\bpercent(?:age)?s?\b/i.test(document.text || ""))
    : documents;
  return [...candidates].sort((a, b) => Number(isCfrTitle38Source(b)) - Number(isCfrTitle38Source(a)));
}

export function needsInjuryResearchIntake(question, history = []) {
  if (!isInjuryResearchQuestion(question)) return false;
  const purpose = /\b(?:ratings?|percentage|percent|claims?|filing|file|benefits?|eligib\w*|qualif\w*|service connection|evidence|options|CFR)\b|%/i;
  if (purpose.test(question) || /[?]|\b(?:what|how|why|can|could|does|which)\b/i.test(question)) return false;
  const preceding = [...history].reverse().find(turn => turn?.role === "user")?.content || "";
  return !purpose.test(preceding);
}

export function injuryResearchClarification(question, unavailable = false, matched = false, rejectedDraft = false) {
  const region = injuryRegions(question).find(item => !["arm", "leg"].includes(item.name)) ||
    injuryRegions(question)[0];
  const detail = region
    ? `For the ${region.name} issue, are you asking about service connection, filing a claim, or the published rating criteria?`
    : "Which injury or body area is involved, and are you asking about service connection, filing a claim, or rating criteria?";
  const intro = rejectedDraft
    ? "I found potentially relevant material, but couldn't produce a source-supported answer to your disability-benefits question. I can still help narrow the research."
    : matched ? "I can help research the relevant CFR provisions."
    : `${unavailable ? "The source search is temporarily unavailable." : "I haven't found a matching source passage yet."} I can still help narrow the research.`;
  return `${intro}\n\n${detail}\n\nYou don't need to know a diagnostic code or repeat service facts you've already shared. I won't guess percentages or eligibility rules while the supporting criteria are unverified.`;
}

export function isSafeInjuryClarification(answer) {
  const text = String(answer || "")
    .replace(/\[LAW_CENTER_BANNER\]/g, "")
    // A question referring to the reported event is not a rating, payment,
    // deadline or eligibility rule. The strict question-only filter remains.
    .replace(/\b9[/-]11(?:\/2001)?\b/g, "the reported event")
    .replace(/^For more information, visit the \[Reserve Service Law Center\]\(https:\/\/roa\.org\/lawcenter\/?\)\.?\s*$/gim, "")
    .replace(/^For advice specific to your situation, consult a JAG attorney or accredited VA claims agent\.\s*$/gim, "")
    .trim();
  if (!text || text.length > 650 ||
      /\d|%|\$|https?:\/\/|\b(?:SSN|address|date of birth|full name|guarantee\w*|automatically|entitled|always|must|eligible|qualif(?:y|ies))\b/i.test(text)) return false;
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [];
  let hasQuestion = false;
  return sentences.every(sentence => {
    const value = sentence.trim();
    if (/^(?:I can help research the relevant (?:CFR|VA) (?:rules|provisions|sections)|I can help narrow (?:the|your) (?:research|search))\.$/i.test(value)) return true;
    if (/\?$/.test(value) &&
        /^(?:what|which|how|when|where|are you|can you|could you|do you|would you|is your|have you|did you|were you|was it|does)\b/i.test(value) &&
        /\b(?:injur\w*|body|shoulder|knee|ankle|diagnos\w*|respirator\w*|breath\w*|symptoms?|Pentagon|exposure|motion|limitat\w*|service|serving|training|drill|claims?|benefits?|ratings?|duty|condition|dominant|arm|leg|research|eligib\w*|happen|it|this|that)\b/i.test(value)) {
      hasQuestion = true;
      return true;
    }
    return false;
  }) && hasQuestion;
}
