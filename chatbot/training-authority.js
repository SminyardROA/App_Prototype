// Retrieval routing and source selection only, never an eligibility decision.
export const TRAINING_STATUTE_URL = "https://www.law.cornell.edu/uscode/text/38/101";
export const GUARD_RESERVE_TRAINING_CAVEAT = `STANDING GUARD/RESERVE VETERAN-DEFINITION CAVEAT:
In the first substantive explanation of Title 38 Veteran status for a Guard or Reserve member, include this distinction even if they did not specifically ask about training; do not repeat it unnecessarily in every follow-up. Cite relevant supplied statutory, CFR or explanatory passages; these instructions are not a substitute for source evidence.
REQUIRED EARLY WORDING FOR THAT DEFINITION ANSWER: After at most one sentence giving § 101(2), explicitly say: "For Guard and Reserve members, IADT—including basic training on training orders—is active duty for training under § 101(22), not active duty under § 101(21)(A), which excludes active duty for training." Follow immediately with the § 101(24)(B) qualifying disability/death exception. Do not replace this explicit IADT/§ 101(21) caveat with only an ADT-versus-IDT list. Keep these points ahead of honorary status or unrelated program examples.
Under 38 U.S.C. § 101(21)(A), "active duty" is full-time duty in the Armed Forces "other than active duty for training." Guard and Reserve initial active duty for training (IADT), including basic training performed on training orders, is active duty for training under § 101(22). IADT alone generally does not establish "active service" or Veteran status under Title 38.
Always preserve the exception: under § 101(24)(B), a period of ADT can qualify as active service when the person was disabled or died from a disease or injury incurred or aggravated in line of duty during that period. Do not say training can never qualify, or that a unit line-of-duty finding alone establishes VA service connection.
Do not assume all basic training is Guard/Reserve IADT: regular active-duty enlistment is different. Consider other qualifying service, and keep Veteran status separate from each benefit's eligibility rules; do not categorically deny all benefits to someone whose only full-time duty was training.`;
export const TRAINING_STATUTE_FILTER = {
  $and: [
    { sourceKind: { $eq: "us-statute" } },
    { section: { $eq: "101" } },
    { url: { $eq: TRAINING_STATUTE_URL } },
  ],
};

export function isTrainingServiceResearch(question) {
  const text = String(question || "");
  const training = /\b(?:initial (?:active duty|entry) training|active[- ]duty for training|inactive[- ]duty training|basic training|annual training|advanced individual training|IADT|ADT|ACDUTRA|IDT|INACDUTRA|weekend drills?|drill weekends?)\b/i;
  const purpose = /\b(?:VA|veterans?|benefits?|disabilit\w*|claims?|service[- ]connect\w*|line of duty|qualif\w*|eligib\w*)\b|38\s*U\.?\s*S\.?\s*C\.?|(?:count|definition|means?|considered).{0,50}active[- ]duty/i;
  return training.test(text) && (purpose.test(text) ||
    /\b(?:difference|different|versus|vs\.?|compare)\b/i.test(text));
}

const definitions = {
  "2": /veteran.{0,180}discharged or released.{0,80}other than dishonorable/i,
  "21": /full-time duty.{0,100}other than active duty for training/i,
  "22": /full-time duty.{0,120}(?:Reserves|Reservists).{0,60}training purposes/i,
  "23": /inactive duty training.{0,180}other than full-time duty/i,
  "24": /active duty for training.{0,180}disabled or died from a disease or injury incurred or aggravated in line of duty/i,
};

function validDefinition(text, subsection) {
  // Check the actual numbered passage, not words elsewhere in the record.
  const start = text.indexOf(`(${subsection})`);
  if (start < 0) return false;
  const next = text.slice(start + subsection.length + 2).search(/\(\d+\)\s*The term/);
  const body = next < 0 ? text.slice(start) : text.slice(start, start + subsection.length + 2 + next);
  if (!definitions[subsection].test(body)) return false;
  return subsection !== "24" ||
    /inactive duty training.{0,300}injury incurred or aggravated in line of duty/i.test(body) &&
    /acute myocardial infarction.{0,40}cardiac arrest.{0,40}cerebrovascular accident/i.test(body);
}

export function selectTrainingAuthority(matches = []) {
  const candidates = matches.filter(match => {
    const m = match.metadata || {};
    let url;
    try { url = new URL(m.url); } catch { return false; }
    return url.origin + url.pathname.replace(/\/$/, "") === TRAINING_STATUTE_URL &&
      String(m.section) === "101" && m.sourceKind === "us-statute" &&
      /38 U\.S\. Code § 101\b/i.test(String(m.title || ""));
  }).map(match => ({ match, text: String(match.metadata.text || "")
    .normalize("NFKC").replace(/\s+/g, " ") }));
  const keys = Object.keys(definitions);
  // Prefer the verbatim companion passage: one authority slot, all related
  // definitions, independent of its similarity score.
  const companion = candidates.find(({ text }) => keys.every(key => validDefinition(text, key)));
  if (companion) return [companion.match];
  const selected = new Map();
  for (const key of keys) {
    const candidate = candidates.find(({ text }) => validDefinition(text, key));
    if (candidate) selected.set(candidate.match.id, candidate.match);
  }
  return [...selected.values()];
}

export function trainingAuthorityInstruction(question, documents = []) {
  if (!isTrainingServiceResearch(question) ||
      !documents.some(doc => doc.url === TRAINING_STATUTE_URL)) return "";
  return `\n\nTRAINING SERVICE DEFINITIONS:
Use the supplied 38 U.S.C. 101 passages for the legal definitions, alongside relevant CFR provisions and Law Review explanations. Do not confuse DoD pay, retirement points, or DD214 reporting with Title 38 eligibility.
Distinguish "active duty" under 101(21) from the broader "active military, naval, air, or space service" under 101(24). Initial active duty for training is not active duty under 101(21)(A). ADT can qualify as active service under 101(24)(B) only when the person was disabled or died from a disease or injury incurred or aggravated in line of duty during that period. IDT has a different rule: disability or death from an injury incurred or aggravated in line of duty, or from an acute myocardial infarction, cardiac arrest, or cerebrovascular accident occurring during that training. Do not generalize all diseases to IDT.
Do not assume that "basic training" always means Reserve/Guard ADT: regular active-duty enlistment and Reserve/Guard initial ADT are different situations. If the user has not supplied the duty status, explain the ADT rule conditionally and ask whether their training was under a regular active-duty enlistment or Reserve/Guard training orders. Do not invent their status.
Explain only the distinction relevant to the question, with a supporting citation. Do not turn training alone, a DD214, a unit LOD finding, or a service duration into automatic Veteran status or eligibility for every benefit. Keep benefit-specific routes separate; do not deny all benefits solely because the general definition may not apply. Answer conceptual questions before asking at most ONE genuinely missing service fact. Keep this explanation to about 120–170 words including citations, without a separate reading list. No retrieval-status narration and no claim-by-claim AI audit.`;
}

// Normalize unlinked parenthesized source lists before the shared citation
// formatter resolves them against this request's actual context ordering.
export function normalizeTrainingCitationLists(answer) {
  return String(answer || "").replace(
    /\((Source\s+\d+(?:\s*[,;]\s*Source\s+\d+)*)\)/gi,
    (_whole, list) => `(${list.replace(/Source\s+(\d+)/gi, "[Source $1]")})`,
  );
}
