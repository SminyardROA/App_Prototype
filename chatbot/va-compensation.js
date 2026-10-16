import { readFileSync } from "node:fs";

export const vaCompensationSnapshot = JSON.parse(
  readFileSync(new URL("./va-compensation-rates.json", import.meta.url), "utf8"),
);
const snapshot = vaCompensationSnapshot;
const source = snapshot.sourceUrl;
if (source !== "https://www.va.gov/disability/compensation-rates/veteran-rates/" ||
    snapshot.effectiveDate !== `${snapshot.rateYear - 1}-12-01` ||
    Object.keys(snapshot.basic).length !== 12) throw new Error("Invalid official VA compensation snapshot");

const money = cents => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const cite = `[VA compensation table](${source})`;
export const CCK_2027_RATES_URL = "https://cck-law.com/blog/2027-va-disability-pay-rates-and-cost-of-living-adjustment/";
// Owner's cutoff is January 1 in their America/New_York timezone.
const CCK_REFERENCE_END = new Date("2027-01-01T00:00:00-05:00").getTime();
export function cck2027RateReference(years, now = new Date()) {
  if (!years.includes(2027) || now.getTime() >= CCK_REFERENCE_END) return null;
  return {
    text: `For a VA-disability law firm's overview, see [CCK Law's 2027 VA disability rates and COLA guide](${CCK_2027_RATES_URL}). This is a law-firm reference, not an official VA rate table.`,
    url: CCK_2027_RATES_URL,
  };
}
const lookupContext = /\bVA (?:disability )?(?:payment|compensation) (?:lookup|table)|\bVA combined disability rating\b/i;
const countWords = { zero: 0, no: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
const number = value => /^\d+$/.test(value) ? Number(value) : countWords[value?.toLowerCase()];
const n = "(\\d+|zero|no|one|two|three|four|five|six|seven|eight|nine|ten|a|an)";
const thirdParty = /\b(?:my|a) (?:friend|buddy|neighbor|coworker)|\bmy (?:father|mother|son|daughter)\s+(?:has|gets|receives|is rated)\b|\bsomeone else\b/i;
const hypothetical = /\b(?:what if|suppose|hypothetical|assuming|if I (?:had|were|was|got))\b/i;

export function isVaCompensationQuestion(message) {
  const text = String(message || "");
  if (/\b(?:SSDI|social security|workers.? compensation)\b/i.test(text) && !/\bVA\b/i.test(text)) return false;
  if (/\b2027\b/.test(text) && /\bdisability\b/i.test(text) &&
      /\b(?:rates?|pay|paid|payments?|COLA|chart|table)\b/i.test(text)) return true;
  return /\b(?:VA|veterans?)\b/i.test(text) &&
    (/\b(?:disability|compensation|rating|rated|COLA)\b/i.test(text) || /\d\s*%/.test(text)) &&
    /\b(?:pay|paid|payment|rates?|amount|monthly|money|dollars?|COLA|chart|table|receive|worth)\b/i.test(text);
}

function factsFrom(text, previous = {}) {
  const facts = { ...previous };
  const years = [...text.matchAll(/\b20\d{2}\b/g)].map(m => Number(m[0]));
  if (years.length && (isVaCompensationQuestion(text) ||
      /^(?:(?:for|in|use|what about)\s+)?20\d{2}(?:\s+(?:instead|please|rates?))?[.!?]?$/i.test(text.trim()))) {
    facts.years = [...new Set(years)];
  }
  const percentages = [...text.matchAll(/\b(\d{1,3})\s*(?:%|percent\b)/gi)].map(m => Number(m[1]));
  if (percentages.length) facts.ratings = [...new Set(percentages)];
  const combined = text.match(/\b(?:combined(?: disability)? rating(?: is| of)?|rated(?: at)?)\s*(\d{1,3})(?!\d)/i);
  if (combined) facts.ratings = [Number(combined[1])];
  const noDependents = /\b(?:no|without|don't have any|do not have any)\s+(?:qualifying )?dependents\b/i.test(text);
  if (noDependents) {
    Object.assign(facts, { spouse: false, parents: 0, under18: 0, school: 0, children: 0, aid: false });
    return facts;
  }
  if (/\b(?:single|unmarried|divorced|widowed|no spouse|without (?:a )?spouse|not married)\b/i.test(text)) facts.spouse = false;
  else if (/\b(?:married|spouse|wife|husband)\b/i.test(text)) facts.spouse = true;
  if (/\b(?:no|without|zero)\s+(?:dependent )?parents?\b/i.test(text)) facts.parents = 0;
  else {
    const parents = text.match(new RegExp(`${n}\\s+(?:dependent )?parents?\\b`, "i"));
    if (parents) facts.parents = number(parents[1]);
  }
  if (/\b(?:no|without|zero)\s+(?:dependent )?(?:children|kids)\b/i.test(text)) {
    Object.assign(facts, { children: 0, under18: 0, school: 0 });
  } else {
    const children = text.match(new RegExp(`${n}\\s+(?:dependent )?(?:children|kids|child)\\b`, "i"));
    if (children) {
      facts.children = number(children[1]);
      // A revised child count invalidates a previous age breakdown.
      delete facts.under18;
      delete facts.school;
      const under = text.match(new RegExp(`${n}\\s+(?:dependent )?(?:children|kids|child)(?:\\s+(?:all|who are))?\\s+under\\s+(?:age\\s+)?18\\b`, "i"));
      if (under) { facts.under18 = number(under[1]); facts.school = 0; }
      const school = text.match(new RegExp(`${n}\\s+(?:additional\\s+)?(?:children|kids|child)\\s+(?:over\\s+(?:age\\s+)?18|(?:aged?\\s+)?(?:19|20|21|22|23))[^.!?]{0,45}(?:school|college|university)`, "i"));
      if (school) { facts.school = number(school[1]); facts.under18 ??= 0; }
      const ages = text.match(/\bages?\s+((?:\d{1,2}(?:\s*(?:,|and|&)\s*|\s*$))+)/i);
      const values = ages?.[1].match(/\d+/g)?.map(Number);
      if (values?.length === facts.children && values.every(age => age < 18)) {
        facts.under18 = facts.children; facts.school = 0;
      }
    }
    // Explicit breakdown can be supplied in a follow-up without "children".
    const under = text.match(new RegExp(`${n}\\s+under\\s+(?:age\\s+)?18\\b`, "i"));
    const school = text.match(new RegExp(`${n}\\s+(?:over\\s+(?:age\\s+)?18[^.!?]{0,25}(?:school|college)|in\\s+(?:a qualifying\\s+)?(?:school|college))`, "i"));
    if (under) facts.under18 = number(under[1]);
    if (school) facts.school = number(school[1]);
  }
  if (/\bspouse\b.{0,40}\b(?:no|not|doesn't|does not)\b.{0,20}\b(?:Aid and Attendance|A&A)\b/i.test(text)) facts.aid = false;
  else if (/\b(?:spouse|wife|husband)\b.{0,50}\b(?:Aid and Attendance|A&A)\b/i.test(text)) facts.aid = true;
  return facts;
}

export function compensationAmount({ rating, spouse = false, parents = 0, under18 = 0, school = 0, aid = false }) {
  if (![10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(rating) ||
      !Number.isInteger(parents) || parents < 0 || parents > 2 ||
      !Number.isInteger(under18) || under18 < 0 || under18 > 20 ||
      !Number.isInteger(school) || school < 0 || school > 20) return null;
  if (rating < 30) return { total: snapshot.smallRatings[rating], base: snapshot.smallRatings[rating], extras: [] };
  // The page labels school amounts as "each additional child". Do not guess
  // the base category for school-age-only or disabled-adult-child cases.
  if (school > 0 && under18 === 0) return null;
  const row = snapshot.basic[`${Number(spouse)}-${parents}-${Number(under18 > 0)}`];
  const base = row?.amounts[rating];
  if (!Number.isSafeInteger(base)) return null;
  const extras = [];
  if (under18 > 1) extras.push({ label: `${under18 - 1} additional child${under18 > 2 ? "ren" : ""} under 18`,
    count: under18 - 1, each: snapshot.additions.childUnder18.amounts[rating] });
  if (school) extras.push({ label: `${school} additional child${school > 1 ? "ren" : ""} over 18 in a qualifying school program`,
    count: school, each: snapshot.additions.schoolChildOver18.amounts[rating] });
  if (spouse && aid) extras.push({ label: "spouse Aid and Attendance addition",
    count: 1, each: snapshot.additions.spouseAidAttendance.amounts[rating] });
  return { base, extras, total: base + extras.reduce((sum, item) => sum + item.count * item.each, 0) };
}

export function vaCompensationTurn(message, history = [], now = new Date()) {
  const text = String(message || "").trim();
  const lastAssistant = [...history].reverse().find(turn => turn.role === "assistant")?.content || "";
  const pending = lookupContext.test(lastAssistant) || isVaCompensationQuestion(lastAssistant);
  const shortFollowup = pending && (text.length < 180) &&
    /^(?:\d|yes\b|no\b|single\b|married\b|one\b|two\b|three\b|four\b|my (?:wife|husband|spouse|children|kids)\b|I (?:am|'m|have|don't|do not)\b|with\b|without\b|all\b|what about\b|actually\b)/i.test(text);
  const currentFacts = factsFrom(text);
  const substantiveReply = Object.keys(currentFacts).length > 0 || /^\d{1,3}$/.test(text);
  if (!isVaCompensationQuestion(text) && !(shortFollowup && substantiveReply)) return null;
  const directReference = cck2027RateReference(
    [...text.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0])), now,
  );
  if (directReference) {
    return {
      text: `For official payment amounts, check ${cite}. I don't have a verified official **2027 VA disability rate table** to quote here.\n\n${directReference.text}`,
      sources: [source, directReference.url],
    };
  }
  // Complex entitlement, retroactive payments, offsets and rating prediction
  // remain full-RAG research, not an inferred take-home amount.
  if (/\b(?:back pay|backpay|retroactive|SMC|special monthly compensation|DIC|pension|recoup|offset|severance|garnish|TDIU|unemployability|child support)\b/i.test(text)) return null;
  const reply = answer => ({ text: answer, sources: [source] });
  let facts = {};
  const newSubject = thirdParty.test(text) || hypothetical.test(text) || /\b(?:what about me|for myself|my own)\b/i.test(text);
  if (!newSubject) {
    // Use member facts only, never assistant examples or another person's facts.
    const lastOther = history.findLastIndex(turn => turn.role === "user" && thirdParty.test(turn.content));
    const lastHypothetical = history.findLastIndex(turn => turn.role === "user" && hypothetical.test(turn.content));
    const start = pending && lastHypothetical > lastOther ? lastHypothetical : lastOther + 1;
    for (let i = start; i < history.length; i++) {
      const turn = history[i];
      if (turn.role !== "user") continue;
      const previousRating = facts.ratings;
      facts = factsFrom(turn.content, facts);
      const ratingContext = /\bVA\b|\b(?:combined|disability) rating|\brated\b/i.test(turn.content) ||
        history[i - 1]?.role === "assistant" && lookupContext.test(history[i - 1].content);
      if (!ratingContext) {
        if (previousRating) facts.ratings = previousRating;
        else delete facts.ratings;
      }
      if (/^\d{1,3}$/.test(turn.content.trim()) && history[i - 1]?.role === "assistant" &&
          /combined disability rating/i.test(history[i - 1].content)) {
        facts.ratings = [Number(turn.content.trim())];
      }
    }
  }
  facts = factsFrom(text, facts);
  if (shortFollowup && /^\d{1,3}$/.test(text) && /combined disability rating/i.test(lastAssistant)) {
    facts.ratings = [Number(text)];
  }
  const requestedYear = facts.years?.length === 1 ? facts.years[0] : null;
  if (facts.years?.length > 1 || requestedYear && requestedYear !== snapshot.rateYear) {
    const reference = cck2027RateReference(facts.years || [], now);
    if (reference) return {
      text: `For official payment amounts, check ${cite}. I don't have a verified official **2027 VA disability rate table** to quote here.\n\n${reference.text}`,
      sources: [source, reference.url],
    };
    return reply(`This VA compensation lookup has verified **${snapshot.rateYear} rates**, effective December 1, ${snapshot.rateYear - 1}, not a verified ${requestedYear || "multi-year"} table. I won't present a third-party COLA calculation as an official payment amount. You can check the latest publication at ${cite}. Would you like a ${snapshot.rateYear} comparison instead?`);
  }
  const date = now.toISOString().slice(0, 10);
  if (!requestedYear && (date < snapshot.effectiveDate || date > snapshot.currentUseThrough)) {
    return reply(`The saved VA compensation table is for **${snapshot.rateYear}**, effective December 1, ${snapshot.rateYear - 1}; I can't label it the current rate for today without an updated table. Check ${cite}, or ask explicitly for a ${snapshot.rateYear} historical comparison.`);
  }
  if (/\b(?:all ratings|all percentages|(?:full|complete)\b.{0,35}\b(?:table|chart)|rates by (?:rating|percentage))\b/i.test(text) &&
      /\b(?:no dependents|without dependents|veteran alone)\b/i.test(text)) {
    const lines = [10,20,30,40,50,60,70,80,90,100].map(rating => `${rating}%: **${money(compensationAmount({ rating }).total)}**`);
    return reply(`VA's **${snapshot.rateYear} monthly compensation rates, no dependents**, effective December 1, ${snapshot.rateYear - 1}:\n\n${lines.join("\n")}\n\n${cite}. These are published amounts for the stated ratings, not a prediction of the rating VA would assign.`);
  }
  if (!facts.ratings?.length) {
    return reply(`For a VA disability payment lookup, what's your **combined disability rating** (10%–100%), or the hypothetical percentage you'd like to compare? I can match it to VA's ${snapshot.rateYear} table; I can't predict the rating an injury will receive. ${cite}.`);
  }
  if (facts.ratings.length !== 1 || ![10,20,30,40,50,60,70,80,90,100].includes(facts.ratings[0])) {
    return reply(`For this VA compensation lookup, please give **one combined rating** in a 10% step from 10% through 100%. I won't add separate condition percentages together or infer an unpublished table row. ${cite}.`);
  }
  const rating = facts.ratings[0];
  if (facts.parents !== undefined && facts.parents > 2) {
    return reply(`VA's published table has categories for zero, one, or two dependent parents. Which category should this VA compensation lookup use? ${cite}.`);
  }
  if (rating >= 30 && facts.spouse === undefined && facts.children === undefined &&
      facts.parents === undefined && facts.under18 === undefined) {
    return reply(`For this **VA compensation lookup at ${rating}%**, do you have a spouse, dependent parents, or dependent children? Include the number and ages of children, or say **“no dependents.”** That determines which ${snapshot.rateYear} table row applies. ${cite}.`);
  }
  if (rating >= 30 && facts.children > 0 && facts.under18 === undefined) {
    return reply(`For this VA compensation lookup, how many of those children are **under 18**, and how many are **over 18 in a qualifying school program**? The table uses different additions for those categories. ${cite}.`);
  }
  const under18 = facts.under18 || 0, school = facts.school || 0;
  const amount = compensationAmount({ rating, spouse: facts.spouse || false,
    parents: facts.parents || 0, under18, school, aid: facts.aid || false });
  if (!amount || /\b(?:disabled adult child|helpless child|permanently incapable)\b/i.test(text)) {
    return reply(`This VA compensation lookup shouldn't guess a base amount for that child arrangement. ${cite} lists separate school-child additions; the applicable category needs confirmation before I give a total. Are any qualifying dependent children under 18?`);
  }
  const arrangement = rating < 30 ? "the same published rate with or without dependents" :
    `${facts.spouse ? "with a spouse" : "without a spouse"}, ${facts.parents || 0} dependent parents, ${under18} child${under18 === 1 ? "" : "ren"} under 18${school ? `, and ${school} additional qualifying school-age child${school === 1 ? "" : "ren"}` : ""}`;
  const assumptions = rating >= 30 && (facts.spouse === undefined || facts.parents === undefined ||
    facts.children === undefined && facts.under18 === undefined)
    ? "\n\nThis uses only the dependents you listed and assumes no others; tell me if that needs correction." : "";
  const breakdown = amount.extras.length
    ? `\n\nCalculation: ${money(amount.base)} base${amount.extras.map(item => ` + ${item.count} × ${money(item.each)} (${item.label})`).join("")}.`
    : "";
  return reply(`Using VA's **${snapshot.rateYear} compensation table**, effective **December 1, ${snapshot.rateYear - 1}**, the published **${rating}%** amount is **${money(amount.total)} per month** — ${arrangement}.${breakdown}${assumptions}\n\n${cite}. This is a table-based amount, not a prediction of your rating, approval, or actual deposit after any individual adjustments.`);
}
