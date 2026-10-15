// Safety phrase lists: keep these grouped and plainly worded so maintainers
// can review or update the rules without changing the classifier logic.
export const HIGH_SELF_HARM_PHRASES = [
  "kill myself",
  "end my life",
  "want to die",
  "i want to die",
  "better off dead",
  "no reason to live",
  "no point in living",
  "do not want to be here anymore",
  "do not want to live",
  "hurt myself",
  "harm myself",
  "cut myself",
  "overdose on purpose",
  "take an overdose",
  "shoot myself",
  "hang myself",
  "planning to end it",
  "plan to end my life",
  "going to end my life",
  "ending it all",
  "i want to unalive",
  "i am going to unalive",
  "unalive myself",
  "kms",
  "i am suicidal",
  "i feel like a burden",
  "everyone would be better off without me",
  "people would be better off without me",
  "saying goodbye to everyone",
  "giving away my possessions",
];

export const HIGH_HARM_TO_OTHERS_PHRASES = [
  "want to hurt someone",
  "want to hurt him",
  "want to hurt her",
  "want to hurt them",
  "want to hurt my supervisor",
  "going to hurt someone",
  "going to hurt him",
  "going to hurt her",
  "going to hurt them",
  "going to hurt my supervisor",
  "plan to hurt someone",
  "planning to hurt someone",
  "going to kill someone",
  "going to kill him",
  "going to kill her",
  "going to kill them",
  "going to kill my supervisor",
  "plan to kill someone",
  "planning to kill someone",
  "planning to shoot someone",
  "planning to shoot him",
  "planning to shoot her",
  "planning to shoot them",
  "planning to shoot my supervisor",
  "want to shoot someone",
];

export const INFORMATIONAL_CRISIS_PHRASES = [
  "suicide prevention",
  "suicide prevention resources",
  "suicide prevention program",
  "suicide prevention training",
  "suicide policy",
  "suicide statistics",
  "suicide awareness",
  "suicide screening",
  "suicide hotline",
  "suicide risk factors",
  "suicide prevention and response program",
  "suicide prevention and resilience program",
  "srp",
  "arp resources",
  "army reserve suicide",
  "suicide research",
  "suicide rates",
];

// Common, non-crisis military uses: these terms alone are not intent.
export const NORMAL_MILITARY_LANGUAGE_PHRASES = [
  "weapons qualification",
  "rifle qualification",
  "qualification at the range",
  "at the range",
  "kill switch",
  "casualty reporting",
];

const DATE_TEXT = String.raw`(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4})`;

export const REDACTION_NOTICE =
  "It looks like your message included personal information, so we removed it before processing. You don't need to share personal details to get help.";

export const INFORMATIONAL_FOOTER =
  "If you or someone you know is struggling, contact the Veterans Crisis Line: call 988 and press 1, text 838255, or chat at veteranscrisisline.net.";

const CRISIS_MESSAGE_BODY = `You're not alone, and help is available right now — free, confidential, 24/7.

VETERANS CRISIS LINE
For service members (including National Guard and Reserve), veterans, and their families. You don't need to be enrolled in VA.
• Call 988, then press 1
• Text 838255
• Chat online: https://www.veteranscrisisline.net

988 SUICIDE & CRISIS LIFELINE
• Call or text 988
• Chat online: https://988lifeline.org

If you or someone else is in immediate danger, call 911.

I'm an AI assistant and can't provide crisis counseling, but the people at these lines are trained to help.`;

export const CRISIS_MESSAGE = CRISIS_MESSAGE_BODY;
export const CRISIS_OTHERS_MESSAGE =
  `If anyone is in immediate danger, call 911.\n\n${CRISIS_MESSAGE_BODY.replace(
    "\nIf you or someone else is in immediate danger, call 911.",
    "",
  )}`;

function normalizeCrisisText(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/\b(?:i['’]?m|i am)\b/g, "i am")
    .replace(/\b(?:don['’]?t|do not)\b/g, "do not")
    .replace(/\b(?:can['’]?t|cannot)\b/g, "can not")
    .replace(/\bwon['’]?t\b/g, "will not")
    .replace(/\bsuicde\b/g, "suicide")
    .replace(/\bsuicid(?:e|al)?\b/g, "suicide")
    .replace(/\bkms\b/g, "kill myself")
    .replace(/\bunalive(?:d|s|ing)?\b/g, "end my life")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "Hurt myself" can describe an ordinary past physical injury. Only exempt
// it when nearby words make that meaning clear; explicit intent still wins.
function isAccidentalInjuryReport(text) {
  const injury = /\bhurt myself\b/.exec(text);
  if (!injury) return false;
  const context = text.slice(Math.max(0, injury.index - 80), injury.index + injury[0].length + 120);
  return /\b(?:injur(?:ed|y|ies)|sprain(?:ed)?|fractur(?:ed|e)?|knee|ankle|shoulder|back|slipp?ed|fell|accident(?:al|ally)?|annual training|at drill|during drill|at training|during training|while running|while lifting)\b/.test(context) &&
    !/\b(?:on purpose|intentionally|deliberately|self harm|suicid(?:e|al))\b/.test(context);
}

function containsHighSelfHarm(text) {
  if (HIGH_SELF_HARM_PHRASES.some(phrase =>
    phrase !== "hurt myself" && text.includes(normalizeCrisisText(phrase)))) return true;

  // Catch indirect, first-person statements while leaving informational
  // requests and ordinary military terms alone.
  if (/\b(?:i|im)\b.{0,30}\b(?:want|wish|plan|planning|intend|intending|am going to|will|might|keep thinking about|think about|thinking about|feel like)\b.{0,45}\b(?:kill myself|end it|end my life|suicidal|suicide|hurt myself|cut myself|overdose|die)\b/.test(text) ||
      /\b(?:saying goodbye to everyone|giving away (?:all )?(?:my|their) (?:things|possessions))\b/.test(text)) return true;
  return /\bhurt myself\b/.test(text) && !isAccidentalInjuryReport(text);
}

function containsHighHarmToOthers(text) {
  if (HIGH_HARM_TO_OTHERS_PHRASES.some(phrase => text.includes(normalizeCrisisText(phrase)))) return true;

  const action = /\b(?:kill|hurt|harm|shoot|stab|attack)\b/;
  const target = /\b(?<!not )(?<!never )(?:someone|somebody|anyone|anybody|him|her|them|my (?:supervisor|boss|commander|coworker|wife|husband|partner|ex))\b/;
  const actorThenActionThenTarget = /\b(?:i|im|i am|i will|we|we are|we will|plan to|planning to|want to|going to)\b.{0,40}\b(?:kill|hurt|harm|shoot|stab|attack)\b.{0,40}\b(?<!not )(?<!never )(?:someone|somebody|anyone|anybody|him|her|them|my (?:supervisor|boss|commander|coworker|wife|husband|partner|ex))\b/;
  const ambiguousThreat = /\b(?:i|we|im|i am|we are|planning)\b.{0,20}\b(?:plan(?:ning)? to|going to|will)\s+shoot\b/.test(text) &&
    !/\b(?:range|qualification|weapons training|target practice)\b/.test(text);
  return (actorThenActionThenTarget.test(text) && action.test(text) && target.test(text)) ||
    ambiguousThreat;
}

function containsInformationalContext(text) {
  return INFORMATIONAL_CRISIS_PHRASES.some(phrase =>
    text.includes(normalizeCrisisText(phrase)),
  ) || /\b(?:resources?|programs?|polic(?:y|ies)|training|statistics|statistical|prevention|awareness|research)\b/.test(text) &&
    /\b(?:suicide|suicidal|self harm|self injury|killing yourself)\b/.test(text);
}

export function isHarmToOthers(message) {
  return containsHighHarmToOthers(normalizeCrisisText(message));
}

export function detectCrisis(message) {
  const text = normalizeCrisisText(message);
  if (!text) return "none";
  if (containsHighHarmToOthers(text) || containsHighSelfHarm(text)) return "high";
  if (containsInformationalContext(text)) return "informational";
  return "none";
}

export function redactPII(input) {
  if (typeof input !== "string" || !input) return input;
  let text = input;

  // Emails and clearly formatted U.S. phone numbers.
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]");
  text = text.replace(
    /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/g,
    "[REDACTED]",
  );

  // Redact a date only when a nearby label identifies it as a birth date.
  const dobPattern = new RegExp(
    String.raw`\b((?:born|birthday|dob|date\s+of\s+birth)\b[^.;\n]{0,36}?)(${DATE_TEXT})`,
    "gi",
  );
  text = text.replace(dobPattern, (_match, prefix) => `${prefix}[REDACTED]`);

  // A street address must include a number, street name, and street-type word.
  text = text.replace(
    /\b\d{1,6}\s+(?:[A-Z0-9.'-]+\s+){0,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Terrace|Ter|Place|Pl)\.?\b(?:\s+(?:Apt|Apartment|Unit|Suite|Ste|#)\s*[A-Z0-9-]+)?/gi,
    "[REDACTED]",
  );

  // SSNs in common formats and contiguous 9-digit SSN / 10-digit EDIPI values.
  text = text.replace(/\b(?:\d{3}[- ]\d{2}[- ]\d{4}|\d{9,10})\b/g, "[REDACTED]");

  return text;
}