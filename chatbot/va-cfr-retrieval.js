import { isCfrTitle38Source, LIMB_LOSS_TOPIC } from "./injury-retrieval.js";
import { cfrPart } from "./source-provenance.js";
import { isPentagon911HealthQuestion, HEADACHE_TOPIC } from "./legislation-topics.js";
import { isHerbicideResearch } from "./service-health-research.js";

// Retrieval hints only: these do not establish eligibility, percentages, or
// whether a particular diagnostic code applies to a member.
const topics = [
  ["3.303", /service[- ]connection|connect a disability|link.*(?:military|service)/i,
    /facts.{0,80}evidence|particular injury or disease resulting/i],
  ["3.6", /inactive duty|(?:hurt|injur\w*).{0,30}drill|duty periods/i,
    /disabled or died.{0,500}injury/i],
  ["3.306", /aggravat|(?:before|preexist\w*).{0,50}(?:worse|serv)/i],
  ["3.310", /secondary service|proximately|caused by another service[- ]connected/i],
  ["3.159", /duty.to.assist|help.*(?:obtain|gather).*(?:evidence|records)/i],
  ["3.102", /reasonable.doubt|evidence.*(?:balanced|equipoise)/i],
  ["3.400", /effective dates?|payments? can start/i],
  ["3.155", /intent to file|preserve.*claim date/i],
  ["3.2500", /review options|supplemental claims?|higher.level review/i],
  ["20.202", /notice of disagreement|appeal.*(?:decision.*Board|to the Board)/i],
  ["4.40", /functional loss|weakness and loss of function/i],
  ["4.59", /painful (?:motion|movement)|painful movement/i],
  ["4.25", /combined ratings?|percentages.*added together/i],
  ["4.26", /bilateral factor|both arms or both legs/i],
  ["4.85", /hearing (?:loss|impairment)/i],
  ["4.130", /mental.disorder|mental health.*(?:work|relationships)|mental.*rating formula/i],
];
const codes = [
  ["5201", "4.71a", /5201\s+Arm,\s+limitation of motion/i, /shoulder.*(?:motion|movement)|shoulder injury/i],
  ["5202", "4.71a", /5202\s+Humerus,\s+other impairment/i, /humerus|upper.arm bone/i],
  ["5260", "4.71a", /5260\s+Leg,\s+limitation of flexion/i, /knee.flexion|bend.*knee|knee.*bend/i],
  ["5261", "4.71a", /5261\s+Leg,\s+limitation of extension/i, /leg extension|knee.*straighten/i],
  ["5271", "4.71a", /5271\s+Ankle,\s+limited motion/i, /ankle.*(?:motion|movement|injury)/i],
  ["5215", "4.71a", /5215\s+Wrist,\s+limitation of motion/i, /wrist.*(?:motion|movement|injury)/i],
  ["6260", "4.87", /6260\s+Tinnitus,\s+recurrent/i, /tinnitus|ringing in the ears/i],
  ["6847", "4.97", /6847\s+Sleep apnea/i, /sleep apnea/i],
  ["7913", "4.119", /7913\s+Diabetes mellitus/i, /diabetes/i],
  ["8100", "4.124a", /8100\s+Migraine/i, HEADACHE_TOPIC],
  ["7101", "4.104", /7101\s+Hypertensive vascular disease/i, /hypertension/i],
];
const vaContext = /\b(?:VA|veterans?|disability|service[- ]connect\w*)\b|38\s*C\.?F\.?R\.?|\bdiagnostic codes?\b|\bDCs?\s*#?\s*\d{4}\b/i;
const codeSections = [
  [5000, 5299, "4.71a"], [5300, 5399, "4.73"], [6000, 6099, "4.79"],
  [6100, 6100, "4.85"], [6200, 6299, "4.87"], [6300, 6399, "4.88b"],
  [6500, 6899, "4.97"], [7000, 7199, "4.104"], [7200, 7399, "4.114"],
  [7500, 7599, "4.115b"], [7600, 7699, "4.116"], [7700, 7799, "4.117"],
  [7800, 7899, "4.118"], [7900, 7999, "4.119"], [8000, 8999, "4.124a"],
  [9200, 9499, "4.130"], [9900, 9999, "4.150"],
];

export function vaCfrPlans(question) {
  const text = String(question || "");
  const plans = [];
  const add = plan => { if (!plans.some(p => p.key === plan.key)) plans.push(plan); };
  const namedRatingCode = /\b(?:criteria|published|rating|ratings)\b/i.test(text) &&
    codes.some(([code]) => new RegExp(`\\b${code}\\b`).test(text));
  const medicalRating = /rating|criteria|schedule|percentage/i.test(text) &&
    (/mental health|mental.disorder|hearing loss/i.test(text) || HEADACHE_TOPIC.test(text));
  const pentagonHealth = isPentagon911HealthQuestion(text);
  const herbicideResearch = isHerbicideResearch(text);
  const limbLoss = LIMB_LOSS_TOPIC.test(text);
  if (!vaContext.test(text) && !namedRatingCode && !medicalRating && !pentagonHealth && !limbLoss && !herbicideResearch) return [];
  if (/\b(?:SSDI|workers.? compensation|AMA Guides)\b/i.test(text) && !vaContext.test(text)) return [];
  // Do not interpret an unrelated title's section number as a Title 38 rule.
  if (/\b(?:10|20|29|32|50)\s*C\.?F\.?R\.?/i.test(text) && !/\b38\s*C\.?F\.?R\.?/i.test(text)) return [];
  if (pentagonHealth) add({ key: "3.303", section: "3.303", preferred: topics[0][2] });
  if (herbicideResearch) {
    add({ key: "herbicide-exposure", section: "3.307",
      required: /(?:Republic of Vietnam|herbicide agent)/i,
      preferred: /shall be presumed to have been exposed/i });
    add({ key: "herbicide-diseases", section: "3.309",
      required: /(?:disease associated with exposure to certain herbicide|respiratory cancers)/i,
      preferred: /respiratory cancers|Type 2 diabetes|Parkinson/i });
  }
  if (limbLoss) {
    add({ key: "amputation-schedule", section: "4.71a", required: /\bamputat\w*\b/i });
    add({ key: "anatomical-loss-compensation", section: "3.350", required: /\b(?:anatomical loss|loss of use|amputat\w*)\b/i });
    add({ key: "3.303", section: "3.303", preferred: topics[0][2] });
  }
  for (const match of text.matchAll(/\b(?:3|4|20)\.\d+[a-z]?\b/gi)) {
    const section = match[0].toLowerCase();
    add({ key: section, section, explicit: true,
      preferred: topics.find(topic => topic[0] === section)?.[2] });
  }
  for (const [code, section, label, words] of codes) {
    if (new RegExp(`\\b${code}\\b`).test(text) ||
        (words.test(text) && /\brat(?:ing|ings|e)|criteria|schedule|percentage/i.test(text))) {
      add({ key: `code-${code}`, section, code, required: label });
    }
  }
  const explicitCodes = [...text.matchAll(/\b(?:diagnostic codes?|DCs?)\s*#?\s*(\d{4})\b/gi)]
    .map(match => match[1]);
  if (/\bratings?|criteria|schedule\b/i.test(text)) {
    explicitCodes.push(...[...text.matchAll(/\b\d{4}\b/g)].map(match => match[0]));
  }
  for (const code of explicitCodes) {
    if (plans.some(plan => plan.code === code)) continue;
    const range = codeSections.find(([low, high]) => Number(code) >= low && Number(code) <= high);
    if (!range) continue;
    add({ key: `code-${code}`, section: range[2], code,
      // For codes without a hand-checked label, require a capitalized table
      // entry, not "under code 7522", a comma-separated list, or "7522 or...".
      // This is retrieval evidence only, not a diagnosis or personal rating.
      required: code === "6100" ? undefined : new RegExp(`\\b${code}\\s+[A-Z][a-z]`) });
  }
  for (const [section, pattern, preferred] of topics) {
    if (pattern.test(text)) add({ key: section, section, preferred });
  }
  if (/spine|lower back|thoracolumbar/i.test(text) && /rat(?:ing|ings)|criteria|table/i.test(text)) {
    add({ key: "spine", section: "4.71a", required: /thoracolumbar.*forward flexion|forward flexion.*thoracolumbar/i });
  }
  return plans.slice(0, 8);
}

export function cfrPlanMatch(document, plan) {
  if (!isCfrTitle38Source(document) || cfrPart(document) !== Number(plan.section.split(".")[0])) return false;
  const section = String(document.section || "").replace(/^§\s*/, "");
  if (section ? !(section === plan.section || section.startsWith(`${plan.section}(`))
    : !new RegExp(`(?:^|\\n)\\s*(?:38 CFR\\s+)?§\\s*${plan.section.replace(".", "\\.")}(?![\\da-z.])`, "i")
      .test(document.text || "")) return false;
  const text = String(document.text || "").normalize("NFKC").replace(/\s+/g, " ");
  return Boolean(text.trim()) && (!plan.required || plan.required.test(text));
}

// One primary per requested component before supplementary chunks. Metadata
// filters are not trusted on their own: validate authority, section and body.
export function recoverCfrMatches(plans, matches, normalize, limit = 10) {
  const groups = plans.map(plan => {
    const unique = new Map();
    for (const match of matches) {
      const doc = normalize(match);
      if (cfrPlanMatch(doc, plan)) {
        const key = `${doc.url}\n${doc.text}`;
        if (!unique.has(key)) unique.set(key, { match, doc });
      }
    }
    return [...unique.values()].sort((a, b) =>
      Number(Boolean(plan.preferred?.test(b.doc.text.replace(/\s+/g, " ")))) -
        Number(Boolean(plan.preferred?.test(a.doc.text.replace(/\s+/g, " ")))) ||
      (b.match.score || 0) - (a.match.score || 0)).slice(0, 3).map(item => item.match);
  });
  const selected = [];
  const seen = new Set();
  for (let rank = 0; rank < 3; rank++) for (const group of groups) {
    const match = group[rank];
    if (!match) continue;
    const doc = normalize(match), key = `${doc.url}\n${doc.text}`;
    if (!seen.has(key) && selected.length < limit) { selected.push(match); seen.add(key); }
  }
  return selected;
}
