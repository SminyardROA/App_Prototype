// Intake only: these flags record that a subject was addressed, NOT that
// service or eligibility was verified. No personal legal determination here.
const OTHER_PERSON = /\b(?:my (?:friend|buddy|wife|husband|father|mother|son|daughter)|someone else|hypothetically|suppose|what if|for example)\b/i;
const DIFFERENT_TOPIC = /\b(?:USERRA|SCRA|BAH|BAS|TRICARE|drill pay|civilian employer|Susan Lukas|Pentagon|shoulder rating)\b/i;
const DURATION = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\s*(?:days?|months?|years?|weeks?)\b/i;
const NUMERIC_REPLY = /^\s*(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s*(days?|weeks?|months?|years?)?[.!]?\s*$/i;

export function isNumericIntakeReply(message) {
  return NUMERIC_REPLY.test(String(message || ""));
}

export function formatServiceCharacterizationQuestions(answer) {
  const examples = "(Honorable, Under Honorable Conditions, etc.)";
  const term = String.raw`\b(characterization of service|service characterization|discharge characterization|character of discharge)\b`;
  return String(answer || "").split(/(\n\s*\n)/).map(paragraph => {
    if (!paragraph.includes("?")) return paragraph;
    return paragraph
      .replace(new RegExp(`${term}\\s*[—:–-]\\s*Honorable,\\s*Under Honorable Conditions,\\s*etc\\.?`, "gi"),
        (_, label) => `${label} ${examples}`)
      .replace(new RegExp(`${term}(?!\\s*\\(Honorable, Under Honorable Conditions, etc\\.\\))`, "gi"),
        (_, label) => `${label} ${examples}`);
  }).join("");
}

export function veteranIntakeQuestion(message, history = []) {
  message = String(message || "").replace(/^Veteran status \/ benefit eligibility follow-up[^:]*:\s*/i, "");
  if (OTHER_PERSON.test(message)) return null;
  let turns = [];
  for (const turn of history.slice(-24)) {
    if (turn?.role === "user" &&
        (OTHER_PERSON.test(turn.content || "") || DIFFERENT_TOPIC.test(turn.content || ""))) {
      turns = [];
    } else if (["user", "assistant"].includes(turn?.role) && typeof turn.content === "string") {
      turns.push(turn);
    }
  }
  turns.push({ role: "user", content: message });
  const addressed = { duty: false, duration: false, discharge: false, records: false, trainingDisability: false, reserveYears: false };
  let training = false;
  let activeOnly = false;
  let homeLoan = false;
  let ambiguousDuration = null;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "user" || OTHER_PERSON.test(turn.content)) continue;
    const text = turn.content;
    const prior = turns[i - 1]?.role === "assistant" ? turns[i - 1].content : "";
    const numeric = text.match(NUMERIC_REPLY);
    const activeDurationQuestion = /\b(?:how (?:long|much|many days)|number of days)\b[\s\S]*\bactive duty\b/i.test(prior);
    if (numeric) {
      // The latest question supplies the unit, not the number's spelling.
      // A numeric answer must never fill a yes/no or discharge field.
      if (/\bhow many years\b[\s\S]*\bSelected Reserve\b/i.test(prior)) addressed.reserveYears = true;
      if (activeDurationQuestion) {
        if (numeric[2] || /\b(?:how many days|number of days)\b/i.test(prior)) addressed.duration = true;
        else ambiguousDuration = numeric[1];
      }
    }
    if (/^(?:days?|weeks?|months?|years?)[.!]?$/i.test(text.trim()) &&
        /\bdid you mean days, weeks, months, or years of active duty\b/i.test(prior)) addressed.duration = true;
    homeLoan ||= /\bhome loan\b/i.test(text);
    // A natural-language answer can acknowledge uncertainty. Do not loop
    // asking the same question when records/details are genuinely unknown.
    const shortAnswer = /^(?:yes|no|none|not sure|I(?:['’]m| am) not sure|I (?:don't|do not) know|unknown|honorable|general|under honorable conditions|other than honorable|still serving)\b/i.test(text.trim());
    if (shortAnswer) {
      if (activeDurationQuestion) addressed.duration = true;
      if (/\bdischarge|characteriz(?:ation|ed)|release.*service period/i.test(prior)) addressed.discharge = true;
      if (/\bDD\s*(?:Form\s*)?214\b.*\b(?:record|have|available)/i.test(prior)) addressed.records = true;
      if (/\b(?:VA recognized|line of duty|line-of-duty)\b/i.test(prior)) addressed.trainingDisability = true;
      if (/\bhow many\b.*\bSelected Reserve\b/i.test(prior)) addressed.reserveYears = true;
    }
    if (/\b(?:annual training|ADT|IDT|drills?|drilling|training only|Title\s*(?:10|32)|mobiliz\w*|activat\w*|active duty|active-duty)\b/i.test(text)) addressed.duty = true;
    if (/\b(?:annual training|ADT|IDT|drills?|drilling|training only)\b/i.test(text)) training = true;
    // A bare "90 days" answers duration only, not what kind of duty it was.
    if (DURATION.test(text) && (/\b(?:active duty|active-duty|activat\w*|mobiliz\w*)\b/i.test(text) ||
        /\bhow (?:long|much)\b.*\bactive duty\b/i.test(prior))) addressed.duration = true;
    if (/\b(?:no (?:other )?active duty|never (?:activated|mobilized)|only (?:monthly )?drills?|training only)\b/i.test(text)) addressed.duration = true;
    if (/\b(?:no training|no drill|only active duty)\b/i.test(text)) activeOnly = true;
    if (/\b(?:honorabl\w*|dishonorable|other than honorable|general discharge|discharg\w*|still serving|currently serving|released under)\b/i.test(text)) addressed.discharge = true;
    if (/\bDD\s*(?:Form\s*)?214\b/i.test(text) &&
        !/\b(?:what is|what's|do I need|how do I get)\b/i.test(text)) addressed.records = true;
    if (/\b(?:VA (?:disability )?rating|service.connected disability|line.of.duty (?:injury|determination)|no (?:injury|injuries|disability)|injur\w* (?:during|from|at) (?:training|drill|AT)|LOD)\b/i.test(text)) addressed.trainingDisability = true;
    if (/\bSelected Reserve\b/i.test(text) && DURATION.test(text)) addressed.reserveYears = true;
    if (/\b(?:I (?:am|'m) not|no|never served in (?:the )?)\s*(?:Guard|Reserve|Selected Reserve)\b/i.test(text)) {
      addressed.reserveYears = true;
    }
  }
  if (!addressed.duty) return "What kind of duty was that: active duty other than training, annual training/other active duty for training, drill weekends, or a combination?";
  if (!addressed.duration && ambiguousDuration !== null) return `For the ${ambiguousDuration} you entered, did you mean days, weeks, months, or years of active duty other than training?`;
  if (!addressed.duration) return "Roughly how many days of active duty other than training have you performed? You can type a number for days, give a duration such as '6 months', or say you're not sure.";
  if (!addressed.discharge) return "What was the characterization of service (Honorable, Under Honorable Conditions, etc.) for the relevant discharge or release, or are you still serving? If you're unsure, say so.";
  if (!addressed.records) return "Do you have a DD Form 214 or another record of that service available? Please don't upload it or share identifying details.";
  if (training && !activeOnly && !homeLoan && !addressed.trainingDisability) {
    return "Have you had an injury or disease incurred or aggravated in line of duty during training or drill—and, if so, has VA recognized a service-connected disability or assigned a rating for that period? If not, we can still research a possible claim.";
  }
  if (!activeOnly && !addressed.reserveYears) {
    return "How many years have you completed in the Selected Reserve (a drilling unit or full-time support role, not the Individual Ready Reserve)? If that doesn't apply to your service, let me know.";
  }
  return null;
}
