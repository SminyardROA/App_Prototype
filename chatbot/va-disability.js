import { SHOULDER_TOPIC, isShoulderRatingQuestion } from "./shoulder-ratings.js";
import { vaCfrPlans } from "./va-cfr-retrieval.js";
import { SUSAN_LUKAS_TOPIC, PENTAGON_911_EXPOSURE,
  isPentagon911HealthQuestion, isSusanLukasResearchQuestion } from "./legislation-topics.js";
import {
  isInjuryResearchQuestion, injuryRegions, injurySearchQuery, injuryDocumentRelevant, isCfrTitle38Source,
} from "./injury-retrieval.js";

const VA_CONTEXT = /\b(?:VA|Veterans?\s+Affairs|veterans?)\b/i;
const DISABILITY_CONTEXT =
  /\b(?:disabilit(?:y|ies)|service[- ]connected|presumptive|nexus|C&P exam|PACT Act)\b/i;
const RESPIRATORY_TOPIC = /\b(?:respirator\w*|breath\w*|asthma|lungs?|bronch\w*|sinusitis|rhinitis)\b/i;

const SPECIFIC_SUBJECT_PATTERNS = [
    SUSAN_LUKAS_TOPIC,
    SHOULDER_TOPIC,
    /\b(?:cancers?|carcinoma|malignan\w*|lymphoma|glioblastoma|melanoma|leukemia)\b/i,
    /\bprostate cancer\b/i, /\bbreast cancer\b/i, /\b(?:lung|respiratory) cancer\b/i,
    /\bkidney cancer\b/i, /\bpancreatic cancer\b/i,
    /\blymphoma\b/i, /\bmelanoma\b/i, /\bleukemia\b/i, /\bglioblastoma\b/i,
    /\bAgent Orange\b/i, /\bburn pits?\b/i, /\bCamp Lejeune\b/i,
    /\bGulf War\b/i, /\bPTSD\b/i, /\btinnitus\b/i, /\bsleep apnea\b/i,
    /\bTBI\b/i, /\beffective dates?\b/i, /\bintent to file\b/i,
];
const VA_DISABILITY_TOPIC_GROUPS = [
  ...SPECIFIC_SUBJECT_PATTERNS.map(pattern => ({ query: pattern, evidence: pattern })),
  { query: PENTAGON_911_EXPOSURE, evidence: PENTAGON_911_EXPOSURE },
  {
    query: /\b(?:presumptive|PACT Act|Agent Orange|burn pits?|toxic exposure|Camp Lejeune|Gulf War|radiation exposure)\b/i,
    evidence: /\b(?:presumptive|PACT Act|Agent Orange|burn pits?|toxic exposure|Camp Lejeune|Gulf War|radiation exposure)\b/i,
  },
  {
    query: /\b(?:appeal|appeals|supplemental claim|higher[- ]level review|Board of Veterans|BVA|CAVC)\b/i,
    evidence: /\b(?:appeal|supplemental claim|higher[- ]level review|Board of Veterans|BVA|CAVC)\b/i,
  },
  {
    query: /\b(?:rating|ratings|percentage|combined rating|increase|increased rating)\b/i,
    evidence: /\b(?:rating|ratings|percentage|combined rating|increase|increased rating)\b/i,
  },
  {
    query: /\b(?:service[- ]connected|service connection|nexus|link(?:ed)? to service)\b/i,
    evidence: /\b(?:service[- ]connected|service connection|nexus|link(?:ed)? to service)\b/i,
  },
  {
    query: /\b(?:claim|claims|file|filing|application|evidence|medical records|C&P exam)\b/i,
    evidence: /\b(?:claim|claims|file|filing|application|evidence|medical records|C&P exam)\b/i,
  },
  {
    query: /\b(?:compensation|disability benefits?|benefit eligibility|monthly payment|payments?)\b/i,
    evidence: /\b(?:compensation|disability benefits?|benefit eligibility|monthly payment|payments?)\b/i,
  },
];

const STOP_WORDS = new Set([
  "about", "after", "also", "because", "been", "being", "could", "does",
  "from", "have", "help", "into", "just", "might", "more", "what", "when",
  "where", "which", "while", "with", "would", "your", "they", "them",
]);

export function isVaDisabilityQuestion(question) {
  const text = String(question || "");
  const hasDisabilityTerm = /\b(?:disabilit(?:y|ies)|service[- ]connected|presumptive|nexus|PACT Act)\b/i.test(text);
  const hasClaimOrBenefitTerm =
    /\b(?:claim|claims|file|filing|application|rating|ratings|compensation|benefits?|appeal|appeals|evidence|condition|conditions|nexus|service connection|presumptive)\b/i.test(text);
  const hasPresumptiveTopic =
    /\b(?:Agent Orange|burn pits?|toxic exposure|Camp Lejeune|Gulf War|radiation exposure)\b/i.test(text);
  const hasDisabilityProgram = /\b(?:CRDP|CRSC|TDIU|individual unemployability|special monthly compensation|C&P exam)\b/i.test(text);
  const hasNamedCondition = SHOULDER_TOPIC.test(text) || RESPIRATORY_TOPIC.test(text) ||
    /\b(?:PTSD|tinnitus|sleep apnea|TBI|cancers?|carcinoma|lymphoma|melanoma|leukemia)\b/i.test(text);

   return vaCfrPlans(text).length > 0 || isSusanLukasResearchQuestion(text) ||
     hasPresumptiveTopic || hasDisabilityProgram || isShoulderRatingQuestion(text) ||
    isInjuryResearchQuestion(text) ||
    (hasNamedCondition && hasClaimOrBenefitTerm) ||
    (hasDisabilityTerm && (hasClaimOrBenefitTerm || VA_CONTEXT.test(text))) ||
    (VA_CONTEXT.test(text) &&
      /\b(?:claim|claims|rating|ratings|compensation|appeal|appeals|condition|conditions|nexus|service connection|C&P|cancers?|carcinoma|lymphoma|melanoma|leukemia)\b/i.test(text));
}

const FOLLOW_UP = /^(?:what|how|why|when|where|can|could|does|do|is|are|and|also|yes|no|thanks|tell me more|explain that|which)\b/i;
const OTHER_TOPIC = /\b(?:USERRA|SCRA|UCMJ|BAH|BAS|TRICARE|GI Bill|home loans?|housing allowance|drill pay|civilian employer|reemployment|voting|military divorce)\b/i;
const EXPOSURE_CONTEXT = [
  /\bAgent Orange\b/i, /\bburn pits?\b/i, /\bCamp Lejeune\b/i,
  /\bGulf War\b/i, /\bradiation exposure\b/i,
  PENTAGON_911_EXPOSURE,
];
const CONDITION_CONTEXT = [
  /\b(?:prostate|breast|lung|kidney|pancreatic) cancer\b/i,
  /\bcancers?\b/i, /\bPTSD\b/i, /\btinnitus\b/i, /\bsleep apnea\b/i, /\bTBI\b/i,
  /\b(?:carcinoma|lymphoma|melanoma|leukemia|glioblastoma)\b/i,
  SHOULDER_TOPIC,
  RESPIRATORY_TOPIC,
  ...injuryRegions("knee ankle hip wrist elbow lumbar foot arm leg").map(region => region.pattern),
];
const SUBJECT_CONTEXT = [...EXPOSURE_CONTEXT, ...CONDITION_CONTEXT];
const DUTY_CONTEXT = /\b(?:inactive[- ]duty(?:[- ]training)?|active duty for training|IDT|ADT|line of duty)\b/i;

function isFollowUp(text) {
  return FOLLOW_UP.test(text) || SUBJECT_CONTEXT.some(pattern => pattern.test(text)) ||
    /^(?:claims?|ratings?|service connection|compensation|filing|benefits?|honorable|other than honorable|general discharge|Title 10|Title 32|I served|I was|my diagnosis)\b/i.test(text);
}

export function resolveVaDisabilityQuestion(message, history = []) {
  const latest = String(message || "").trim();
  const directlyVa = isVaDisabilityQuestion(latest);
  if (directlyVa && !/^(?:what about|how about|what if|and|also)\b/i.test(latest)) {
    return { question: latest, evidenceQuestion: latest, requiresEvidence: true, followUp: false };
  }
  if (!isFollowUp(latest) || OTHER_TOPIC.test(latest)) {
    return { question: latest, evidenceQuestion: latest, requiresEvidence: false, followUp: false };
  }
  // Follow the current member topic, not old assistant assertions or an older
  // filing task. Stop at a genuine topic change and support multiple follow-ups.
  const userTurns = history.filter(turn => turn?.role === "user" && typeof turn.content === "string");
  let anchor = "";
  for (const turn of [...userTurns].reverse()) {
    if (OTHER_TOPIC.test(turn.content) && !isVaDisabilityQuestion(turn.content)) break;
    if (isVaDisabilityQuestion(turn.content)) { anchor = turn.content; break; }
    if (!isFollowUp(turn.content.trim())) break;
  }
   if (!anchor) return { question: latest, evidenceQuestion: latest, requiresEvidence: directlyVa, followUp: false };
  const topicTurns = userTurns.slice(userTurns.findLastIndex(turn => turn.content === anchor));
  const precedingCondition = [...topicTurns].reverse().find(turn =>
    CONDITION_CONTEXT.some(pattern => pattern.test(turn.content)))?.content || "";
  const precedingExposure = [...topicTurns].reverse().find(turn =>
    EXPOSURE_CONTEXT.some(pattern => pattern.test(turn.content)))?.content || "";
  const latestHasCondition = CONDITION_CONTEXT.some(pattern => pattern.test(latest));
  const latestHasExposure = EXPOSURE_CONTEXT.some(pattern => pattern.test(latest));
  const context = SUBJECT_CONTEXT.flatMap((pattern, index) => {
    const isCondition = index >= EXPOSURE_CONTEXT.length;
    if (pattern.test(latest) || (isCondition ? latestHasCondition : latestHasExposure)) return [];
    const matches = [...(isCondition ? precedingCondition : precedingExposure)
      .matchAll(new RegExp(pattern.source, "gi"))];
    return matches.length ? [matches.at(-1)[0]] : [];
  });
  const precedingDuty = [...topicTurns].reverse().find(turn => DUTY_CONTEXT.test(turn.content));
  if (!DUTY_CONTEXT.test(latest) && precedingDuty) context.push(precedingDuty.content.match(DUTY_CONTEXT)[0]);
  const evidenceQuestion = context.length
    ? `${latest}\nMember's preceding topic: ${[...new Set(context)].join(", ")}`
    : latest;
  return { question: `VA disability: ${evidenceQuestion}`, evidenceQuestion, requiresEvidence: true, followUp: true };
}

export function focusedVaSearchQuery(question) {
  const text = String(question || "");
  if (isSusanLukasResearchQuestion(text)) {
    return `${text}\nSusan E. Lukas Act ROA proposed legislation Pentagon September 11 respiratory illness service members nonresponders; existing VA claim service connection evidence 38 CFR 3.303`;
  }
  if (isInjuryResearchQuestion(text)) return injurySearchQuery(text);
  const cancer = text.match(/\b(?:cancers?|carcinoma|malignan\w*|lymphoma|glioblastoma|melanoma|leukemia)\b/i);
  if (!cancer) return `${text}\nVA disability eligibility evidence`;
  const subjects = SUBJECT_CONTEXT.flatMap(pattern => text.match(pattern)?.[0] ? [text.match(pattern)[0]] : []);
  // Do not replace a volunteered exposure with an unrelated PACT Act
  // assumption. Regulatory anchors improve recovery of the actual lists,
  // but do not establish that any particular condition/exposure qualifies.
  const anchor = /\b(?:herbicides?|Agent Orange)\b/i.test(text)
    ? "38 CFR 3.307 3.309 herbicide exposure"
    : /\b(?:radiation|radiogenic)\b/i.test(text)
      ? "38 CFR 3.309 3.311 radiation exposure"
      : /\bCamp Lejeune\b/i.test(text)
        ? "38 CFR 3.307 3.309 Camp Lejeune"
        : "38 CFR Part 3 presumptive PACT Act";
  return `VA disability ${cancer[0]} ${[...new Set(subjects)].join(" ")} ${anchor}\n${text}`;
}

function topicGroupsFor(question) {
  return VA_DISABILITY_TOPIC_GROUPS.filter(group => group.query.test(String(question || "")));
}

function sourceText(document) {
  return `${document?.title || ""}\n${document?.text || ""}`;
}

function hasVaDisabilityContext(text, document) {
  return DISABILITY_CONTEXT.test(text) ||
    (VA_CONTEXT.test(text) && /\b(?:rating|ratings|compensation|nexus|presumptive)\b/i.test(text)) ||
    /^https:\/\/(?:www\.)?va\.gov\/disability(?:\/|$)/i.test(document?.url || "") ||
    isCfrTitle38Source(document);
}

function hasQuestionTermOverlap(question, text) {
  const questionTerms = new Set(
    String(question || "").toLowerCase().match(/[a-z0-9]+/g)?.map(term => term.replace(/s$/, "")).filter(term =>
      term.length >= 4 && !STOP_WORDS.has(term) && !["veteran", "veterans", "disability"].includes(term)
    ) || [],
  );
  const sourceTerms = new Set((String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .map(term => term.replace(/s$/, "")));
  return [...questionTerms].some(term => sourceTerms.has(term));
}

export function relevantVaDisabilityDocuments(question, documents = []) {
  const groups = topicGroupsFor(question);
  const injuryQuestion = isInjuryResearchQuestion(question);
  // A verified single-bill testimony is one source even when the formal title
  // appears on its cover and later chunks use only the bill number. This does
  // not make any proposed provision operative law.
  const namedProposal = document => isSusanLukasResearchQuestion(question) &&
    document.legalStatus === "proposal-discussion" &&
    document.sourceKind === "roa-testimony" && SUSAN_LUKAS_TOPIC.test(document.title);
  const candidates = documents.filter(document => {
    const text = sourceText(document);
    if (!document?.text?.trim() || !/^https?:\/\//i.test(document?.url || "")) return false;
    if (namedProposal(document)) return true;
    if (!hasVaDisabilityContext(text, document)) return false;
    if (injuryQuestion) return injuryDocumentRelevant(question, document);
    return groups.length
      ? groups.some(group => group.evidence.test(document.text))
      : hasQuestionTermOverlap(question, document.text);
  });

  // Missing procedural details may be acknowledged rather than blocking a
  // supported answer entirely. A named condition/exposure needs its own
  // passage; a different cancer or toxic-exposure article cannot stand in.
  if (SPECIFIC_SUBJECT_PATTERNS.filter(pattern =>
    (!injuryQuestion || pattern !== SHOULDER_TOPIC) && pattern.test(String(question || ""))).some(pattern =>
    !candidates.some(document => pattern.test(document.text) ||
      (pattern === SUSAN_LUKAS_TOPIC && namedProposal(document)))
  )) return [];

  return candidates;
}

export function validateVaCitationLinks(answer, documents = []) {
  const normalize = value => {
    try { const url = new URL(value); url.hash = ""; return url.toString().replace(/\/$/, "").toLowerCase(); }
    catch { return ""; }
  };
  const retrieved = new Set(documents.map(document => normalize(document.url)).filter(Boolean));
  // This exact product closing is navigation, not evidence. Do not let it
  // satisfy the source boundary or reject an otherwise cited answer.
  const evidenceAnswer = String(answer || "").replace(
    /^For more information, visit the \[Reserve Service Law Center\]\(https:\/\/roa\.org\/lawcenter\/?\)\.?\s*$/gim, "",
  );
  const cited = [...new Set((evidenceAnswer.match(/https?:\/\/[^\s<>"\])]+/gi) || [])
    .map(url => normalize(url.replace(/[.,;:!?]+$/, ""))).filter(Boolean))];
  return { hasRetrievedCitation: cited.some(url => retrieved.has(url)),
    hasUnknownCitation: cited.some(url => !retrieved.has(url)) };
}

// Formatting only, not factual verification. Source numbering is the same
// immutable ordering used to build this request's retrieved context.
export function resolveVaCitationMarkers(answer, documents = []) {
  let unresolved = false;
  const text = String(answer || "").replace(
    /\[\[SOURCE:(\d+)\]\]|\[Source\s+(\d+)\](?!\()/gi,
    (marker, first, second) => {
      const number = Number(first || second);
      const doc = documents[number - 1];
      if (!doc || !/^https?:\/\//i.test(doc.url || "")) {
        unresolved = true;
        return marker;
      }
      return `[Source ${number}](${doc.url})`;
    },
  );
  return { text, unresolved };
}
