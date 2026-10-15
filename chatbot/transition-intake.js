// Deterministic ReserveTransition intake. The browser keeps the choices between requests.
export const TRANSITION_CLOSING =
  "ReserveTransition virtual classes are held monthly at roa.org. You can also contact ROA directly at roa.org/contact for personalized guidance.";

export const TRANSITION_QUESTIONS = {
  q1: "To point you to the right resources, I have a quick question: Which of these best describes your situation?\nA) I am separating before retirement eligibility\nB) I am retiring with immediate pay (20+ years, Active Guard/Reserve)\nC) I am a Grey Area retiree (20+ years Reserve, waiting for age 60)\nD) I am not sure yet, still exploring my options",
  q2: "Thanks, and roughly when are you planning to separate or retire?\nA) Within the next 6 months\nB) 6 to 12 months from now\nC) 1 to 2 years from now\nD) Just researching for now",
  q3: "Got it. What is your biggest concern right now? Pick the one that feels most urgent:\nA) VA disability rating and health benefits\nB) Health insurance after I leave\nC) Employment or education after service\nD) Retirement pay and financial planning\nE) I want to understand all my options",
};

export const newTransitionIntake = () => ({
  stage: "not_started",
  answers: { q1: null, q2: null, q3: null },
});

const OPTIONS = {
  q1: [
    [/\bseparat(?:ing|e|ion)\b.*\bbefore\b.*\bretire|before retirement eligibility/i],
    [/\bretir(?:ing|e|ement)\b.*\bimmediate\b|full retiree|active guard\/reserve/i],
    [/\bgrey area\b|\bgray area\b/i],
    [/\bnot sure\b|\bunsure\b|\bstill exploring\b|\bexploring my options\b/i],
  ],
  q2: [
    [/\bwithin (?:the )?(?:next )?6 months\b|\b(?:under|less than) 6 months\b/i],
    [/\b6\s*(?:to|-)\s*12 months\b/i],
    [/\b1\s*(?:to|-)\s*2 years\b/i],
    [/\bjust researching\b|\bresearching for now\b/i],
  ],
  q3: [
    [/\bva disability\b|\bdisability rating\b/i],
    [/\bhealth insurance\b/i],
    [/\bemployment\b|\beducation\b|\bcivilian job\b/i],
    [/\bretirement pay\b|\bfinancial planning\b/i],
    [/\ball (?:my )?options\b/i],
  ],
};

export function parseTransitionAnswer(stage, message, allowLetter = true) {
  if (!OPTIONS[stage] || typeof message !== "string") return null;
  const answer = message.trim().replace(/[.!?]+$/, "").trim();
  if (/\b(?:hypothetically|suppose|what if|for example|my (?:friend|spouse|husband|wife|son|daughter))\b/i.test(answer) ||
      /\bI(?:'m| am)\s+not\s+(?:retiring|separating|leaving)\b/i.test(answer)) return null;
  const count = OPTIONS[stage].length;
  // Single letter, or letter followed by a separator and the option text.
  const letter = answer.match(/^([a-e])(?:\s*[).:-]\s*|\s+|$)/i);
  if (allowLetter && letter && new RegExp(`^[A-${String.fromCharCode(64 + count)}]$`, "i").test(letter[1])) {
    const suffix = answer.slice(letter[0].length).trim();
    if (!suffix) return letter[1].toUpperCase();
    if (OPTIONS[stage][letter[1].toUpperCase().charCodeAt(0) - 65].some(pattern => pattern.test(suffix))) {
      return letter[1].toUpperCase();
    }
    return null;
  }
  const matches = OPTIONS[stage].flatMap((patterns, index) =>
    patterns.some(pattern => pattern.test(answer)) ? [String.fromCharCode(65 + index)] : []);
  if (matches.length) return matches.length === 1 ? matches[0] : null;
  // "Retiring" answers how they are leaving, but does NOT establish when
  // retirement pay starts. Keep that distinction unknown rather than guessing.
  if (stage === "q1" && /\bI(?:(?:'m| am)\s+(?:(?:planning|going)\s+to\s+retire|retiring)| (?:plan to|intend to|will)\s+retire)\b/i.test(answer)) {
    return "retiring";
  }
  if (stage === "q1" && /\bI(?:'m| am)\s+separating\b/i.test(answer)) return "separating";
  if (stage === "q2") {
    const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
      seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const when = /(?:\b(?:in|within|about|roughly)\s+(?:the next\s+)?|^\s*)(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(months?|years?|weeks?)\b/i.exec(answer);
    if (when) {
      const amount = numberWords[when[1].toLowerCase()] ?? Number(when[1]);
      const months = /^year/i.test(when[2]) ? amount * 12 :
        /^week/i.test(when[2]) ? Math.ceil(amount / 4) : amount;
      if (months >= 0 && months <= 600) {
        return months <= 6 ? "A" : months <= 12 ? "B" : months <= 24 ? "C" : `months:${months}`;
      }
    }
  }
  return null;
}

export function rememberTransitionAnswers(intake, message, history = []) {
  const answers = { q1: null, q2: null, q3: null };
  const statements = [...history.filter(turn => turn.role === "user").map(turn => turn.content), message];
  for (const [index, text] of statements.entries()) {
    // Prior recorded choices/corrections outrank older free-form history.
    if (index === statements.length - 1) {
      for (const key of ["q1", "q2", "q3"]) if (intake.answers[key]) answers[key] = intake.answers[key];
    }
    if (typeof text !== "string" ||
        /\b(?:hypothetically|suppose|what if|for example|my (?:friend|spouse|husband|wife|son|daughter))\b/i.test(text) ||
        /\bI(?:'m| am)\s+not\s+(?:retiring|separating|leaving)\b/i.test(text)) continue;
    const departure = /\b(?:retir(?:ing|e|ement)|separat(?:ing|e|ion)|leaving (?:the )?(?:service|military)|getting out)\b/i.test(text);
    const q1 = departure ? parseTransitionAnswer("q1", text, false) : null;
    if (q1 && (q1 !== "retiring" || !["B", "C"].includes(answers.q1) ||
        /\b(?:actually|correction|instead)\b/i.test(text))) answers.q1 = q1;
    const declaredDeparture = /\bI(?:(?:'m| am)\s+(?:(?:planning|going)\s+to\s+(?:retire|separate)|retiring|separating)| (?:plan to|intend to|will)\s+(?:retire|separate))\b/i.test(text);
    const q2 = departure && declaredDeparture ? parseTransitionAnswer("q2", text, false) : null;
    if (q2) answers.q2 = q2;
    if (/\b(?:my (?:biggest|main|primary|top) concern|I(?:'m| am) (?:most )?(?:worried|concerned)|most urgent)\b/i.test(text)) {
      const q3 = parseTransitionAnswer("q3", text, false);
      if (q3) answers.q3 = q3;
    }
  }
  return Object.keys(answers).some(key => answers[key] !== intake.answers[key])
    ? { ...intake, answers } : intake;
}

export function advanceTransitionIntake(intake, message) {
  const remembered = rememberTransitionAnswers(intake, message);
  if (intake.stage === "completed") return remembered;
  const answer = parseTransitionAnswer(intake.stage, message);
  if (intake.stage !== "not_started" && !answer && remembered === intake) return intake;
  const answers = { ...remembered.answers, ...(answer ? { [intake.stage]: answer } : {}) };
  const next = ["q1", "q2", "q3"].find(key => !answers[key]) || "completed";
  return {
    stage: next,
    answers,
  };
}

export function transitionGuidance(intake) {
  const { q1, q2, q3 } = intake.answers;
  const routes = {
    A: "Lead with the urgent 120-day SGLI conversion window, VA intent to claim, paired DD Form 214 and DD Form 214-1 checklist, health insurance bridge options (TAMP, COBRA, marketplace), then employment/education/entrepreneurship according to Q3.",
    B: "Lead with retirement orders and DFAS setup, TRICARE eligibility, SBP election deadline, VA disability claim, and TSP decisions.",
    C: "Lead with Notice of Eligibility, DD Form 2656 timing, TRICARE Retired Reserve during the Grey Area, VA disability claim, and state veterans benefits.",
    D: "Explain the separation, immediate retirement, and Grey Area retirement paths briefly, then ask which sounds closest. Do not assume a retirement category.",
    retiring: "The member is retiring. Do not ask again how they are leaving. Immediate-pay versus Grey Area retirement is NOT established; do not assume either or promise eligibility. If that distinction is necessary for their concern, ask only when retirement pay begins, without repeating departure type or timing.",
    separating: "The member is separating. Do not ask again how they are leaving. Retirement eligibility, voluntary versus involuntary separation, and particular benefits eligibility remain unknown unless separately supplied; clarify only relevant missing details.",
  };
  return `RESERVETRANSITION INTAKE COMPLETE. Server-recorded answers (authoritative; do not infer or revise from chat history): Q1=${q1}, Q2=${q2}, Q3=${q3}. ${routes[q1]} Tailor timing to Q2 and the user's concern to Q3. Do not repeat intake questions 1–3. Answer the original transition question where relevant. End with the required ReserveTransition virtual classes and ROA contact closing.`;
}