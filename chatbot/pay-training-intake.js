// Server-owned first steps of the training pay route. Do not let a generic
// BAH order-length rule interrupt duty-type confirmation and pay grade.
export const TRAINING_CONFIRMATION =
  "Just to confirm — is this Annual Training (AT) or Active Duty for Training (ADT)?\nA) Annual Training (AT)\nB) Active Duty for Training (ADT)\n(Skip — I don't know)";

export const TRAINING_PAY_GRADE =
  "What is your pay grade?\n\nExamples: E-4, E-5, W-2, O-3, O-5 — just enter your grade.\n(Skip this question)";

export const PAY_DEPENDENTS_QUESTION =
  "Do you have any dependents — such as a spouse, children, or other eligible family members?\n\nA) Yes — please tell me how many and their relationship (e.g., \"spouse and two children\")\nB) No dependents\n(Skip this question)";

export const PAY_YEARS_QUESTION =
  "How many years have you served in the military (total, all components)?\n\nThis is used to look up your basic pay on the 2026 pay table.\n(Skip this question)";

export const PAY_OTHER_CIRCUMSTANCES_QUESTION =
  "Last question: Are there any other circumstances you think may affect your pay?\n\nFor example: hostile fire zone, hazardous duty, federal civilian employee, dual compensation waiver, prior service in another branch, or anything else on your mind.\n(Skip this question — I've told you everything)";

export const PAY_LOCATION_QUESTION =
  "Are you serving CONUS (within the continental United States) or OCONUS (overseas or outside the continental US)?\n\nA) CONUS\nB) OCONUS — if you know it, what country or region?\n(Skip this question)";
export const PAY_DEPENDENT_LOCATION_QUESTION =
  "Are your dependents with you at your duty location, or are they staying at your home of record while you serve elsewhere?\n\nA) Dependents are with me at my duty location\nB) Dependents are at my home of record or another location beyond commuting distance\n(Skip this question)";

// Only small, non-identifying confirmed fields travel with browser state.
export function sanitizePayFacts(input) {
  const facts = input && typeof input === "object" ? input : {};
  return {
    ...(/^(?:E-[1-9]|W-[1-5]|O-(?:[1-9]|10))$/.test(facts.grade) ? { grade: facts.grade } : {}),
    ...(Number.isInteger(facts.years) && facts.years >= 0 && facts.years <= 60 ? { years: facts.years } : {}),
    ...(["CONUS", "OCONUS"].includes(facts.location) ? { location: facts.location } : {}),
    ...(typeof facts.hasDependents === "boolean" ? { hasDependents: facts.hasDependents } : {}),
    ...(["with_member", "elsewhere"].includes(facts.dependentLocation) ? { dependentLocation: facts.dependentLocation } : {}),
    ...(["AT", "ADT"].includes(facts.trainingType) ? { trainingType: facts.trainingType } : {}),
    ...(facts.otherKnown === true ? { otherKnown: true } : {}),
  };
}

export function rememberPayFacts(input, message, history = []) {
  const facts = {};
  const statements = [...history.filter(turn => turn.role === "user").map(turn => turn.content), message];
  for (const [index, text] of statements.entries()) {
    if (index === statements.length - 1) Object.assign(facts, sanitizePayFacts(input));
    if (typeof text !== "string" ||
        /\b(?:hypothetically|suppose|what if|for example|my friend)\b/i.test(text)) continue;
    const personal = /\b(?:I|I'm|I've|my)\b/i.test(text) || /^\s*[EWO][ -]?\d{1,2}\b/i.test(text);
    if (!personal) continue;
    const grade = /\b(?:I(?:'m| am)|my (?:pay )?grade(?: is)?)\s+(?:an?\s+)?([EWO])[ -]?(\d{1,2})\b/i.exec(text) ||
      /^\s*([EWO])[ -]?(\d{1,2})\b/i.exec(text);
    if (grade) {
      const normalized = `${grade[1].toUpperCase()}-${Number(grade[2])}`;
      if (sanitizePayFacts({ grade: normalized }).grade) facts.grade = normalized;
    }
    const years = /\bI (?:have|completed)\s+(\d{1,2})\s+years? of (?:military )?service\b/i.exec(text) ||
      /\bI(?:'ve| have) served(?: for)?\s+(\d{1,2})\s+years?\b/i.exec(text) ||
      /\bmy (?:total )?years of service(?: (?:is|are))?\s+(\d{1,2})\b/i.exec(text) ||
      (grade && /\b(?:with|and|,)\s*(\d{1,2})\s+years?(?: of (?:military )?service)?\b/i.exec(text));
    if (years && Number(years[1]) <= 60) facts.years = Number(years[1]);
    const location = /\bI(?:'m| am| serve| am serving)\s+(?:serving\s+|in\s+)?(OCONUS|CONUS)\b/i.exec(text);
    if (location) facts.location = location[1].toUpperCase();
    if (/\b(?:I have|with)\s+no dependents\b|\bI (?:do not|don't) have (?:any )?dependents\b/i.test(text)) {
      facts.hasDependents = false;
      delete facts.dependentLocation;
    } else if (/\bI have\s+(?:dependents|(?:a |one )?spouse|(?:a |one |two |three |\d+ )?children?|(?:a |one |two |three |\d+ )?kids)\b/i.test(text)) {
      facts.hasDependents = true;
    }
    if (/\bmy dependents (?:are |stay(?:ing)? )?(?:with me|at my duty location)\b/i.test(text)) {
      facts.hasDependents = true; facts.dependentLocation = "with_member";
    } else if (/\bmy dependents (?:are |stay(?:ing)? )?(?:at home|at my home of record|elsewhere)\b/i.test(text)) {
      facts.hasDependents = true; facts.dependentLocation = "elsewhere";
    }
    const type = explicitTrainingType(text);
    if (type) facts.trainingType = type;
    if (/\b(?:no other circumstances|I've told you everything|I have no other pay circumstances)\b/i.test(text)) facts.otherKnown = true;
  }
  return facts;
}

export function nextMissingPayQuestion(facts, start = "grade") {
  const stages = ["grade", "location", "years", "dependents", "dependentLocation", "other"];
  const index = stages.indexOf(start);
  for (const stage of stages.slice(Math.max(0, index))) {
    if (stage === "grade" && !facts.grade) return TRAINING_PAY_GRADE;
    if (stage === "location" && !facts.location) return PAY_LOCATION_QUESTION;
    if (stage === "years" && facts.years === undefined) return PAY_YEARS_QUESTION;
    if (stage === "dependents" && facts.hasDependents === undefined) return PAY_DEPENDENTS_QUESTION;
    if (stage === "dependentLocation" && facts.hasDependents === true && !facts.dependentLocation) return PAY_DEPENDENT_LOCATION_QUESTION;
    if (stage === "other" && !facts.otherKnown) return PAY_OTHER_CIRCUMSTANCES_QUESTION;
  }
  return null;
}

// Only a standalone letter may use a lettered option. Parse the final question
// in the actual assistant reply, never a list quoted earlier in the conversation.
export function letteredPayQuestion(text) {
  const lines = String(text || "").split("\n");
  const options = new Map();
  let firstOption = -1;
  let lastOption = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*([A-Z])\)\s+(.+?)\s*$/i.exec(lines[i]);
    if (!match) continue;
    const letter = match[1].toUpperCase();
    if (firstOption < 0) {
      if (letter !== "A") continue;
      firstOption = i;
    } else if (i !== lastOption + 1 && lines.slice(lastOption + 1, i).some(line => line.trim())) {
      options.clear();
      if (letter !== "A") { firstOption = -1; continue; }
      firstOption = i;
    }
    options.set(letter, match[2]);
    lastOption = i;
  }
  if (firstOption < 0 || options.size < 2) return null;
  const before = lines.slice(0, firstOption).join("\n");
  if (!before.includes("?") || /\?/.test(lines.slice(lastOption + 1).join("\n"))) return null;
  return { prompt: before.slice(0, before.lastIndexOf("?") + 1), options };
}

export function selectedPayOption(question, message) {
  const letter = /^([A-Z])\s*\)?$/i.exec(String(message || "").trim())?.[1]?.toUpperCase();
  return letter && question?.options.has(letter)
    ? { letter, answer: question.options.get(letter) }
    : null;
}

// Only a question addressed to the member counts; mentions of years in pay
// explanations and examples must not change the field awaiting an answer.
export function lastPayQuestion(text) {
  const answer = String(text || "");
  if (/\b(?:how many years (?:have you served|of (?:military )?service (?:do you have|have you completed))|what (?:are|is) your (?:total )?years of service)\b[^?]*\?/i.test(answer)) return "yearsOfService";
  if (/\bdo you have any dependents\b[^?]*\?/i.test(answer)) return "dependents";
  return null;
}

export function parseServiceYears(text) {
  const answer = String(text || "").trim();
  if (/^skip(?: this question)?$/i.test(answer)) return { kind: "skip" };
  const match = /^(\d{1,2})(?:\s+years?(?:\s+of (?:military )?service)?)?$/i.exec(answer);
  const prose = /\bI (?:have|completed)\s+(\d{1,2})\s+years?(?: of (?:military )?service)?[.!]?\s*$/i.exec(answer);
  const years = match ? Number(match[1]) : prose ? Number(prose[1]) : rememberPayFacts({}, answer).years;
  return Number.isInteger(years) && years <= 60
    ? { kind: "years", value: years }
    : { kind: "invalid" };
}

export function isPayDutyStatusQuestion(text) {
  return /Which of these best describes your current situation\?/i.test(text) &&
    /B\) I am on orders for Annual Training/i.test(text);
}

export function trainingType(text) {
  const answer = String(text || "").trim();
  if (/^(?:a(?:\s*$|[).:-]\s*)|annual training\b|at\b)/i.test(answer) &&
      !/\b(?:adt|active duty for training)\b/i.test(answer)) return "AT";
  if (/^(?:b(?:\s*$|[).:-]\s*)|active duty for training\b|adt\b)/i.test(answer) &&
      !/\bannual training\b/i.test(answer)) return "ADT";
  return null;
}

export function explicitTrainingType(text) {
  const answer = String(text || "");
  const adt = /\b(?:active duty for training|ADT)\b/i.test(answer);
  const at = /\b(?:annual training|AT orders?)\b/i.test(answer);
  return at && !adt ? "AT" : adt && !at ? "ADT" : null;
}

export function isTrainingChoice(text) {
  return /^(?:b(?:\s*$|[).:-]\s*)|(?:annual training|active duty for training|adt|at)\b)/i
    .test(String(text || "").trim());
}