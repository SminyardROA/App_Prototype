import { cfrPart } from "./source-provenance.js";
export const CFR_PART_4_URL = "https://www.ecfr.gov/current/title-38/chapter-I/part-4";
export const SHOULDER_TOPIC = /\b(?:s\s*houl\s*der|rotator cuff|scapulohumeral|clavicle|humerus|520[0-3])\b/i;

export function isShoulderRatingQuestion(question) {
  const text = String(question || "");
  return SHOULDER_TOPIC.test(text) &&
    /\b(?:ratings?|rate|rated|percentage|percent|520[0-3])\b|%/i.test(text);
}

export function isOfficialShoulderSchedule(document) {
  return cfrPart(document) === 4 &&
    /\b520[0-3]\b/.test(document?.text || "");
}

export function preferShoulderSchedule(question, documents) {
  if (!isShoulderRatingQuestion(question) || !documents.some(isOfficialShoulderSchedule)) return documents;
  // Keep useful claim/background material, but do not mix secondary rating
  // summaries with the actual regulatory table when their figures disagree.
  const primary = documents.filter(isOfficialShoulderSchedule);
  const background = documents.filter(document => !isOfficialShoulderSchedule(document) &&
    (/^https:\/\/www\.ecfr\.gov\/current\/title-38\/chapter-I\/part-\d+(?:$|#)/.test(document.url || "") ||
      !/\b520[0-3]\b|%|\bpercent(?:age)?s?\b/i.test(document.text || "")));
  return [...primary, ...background];
}

export function shoulderMotionCriteria(documents = []) {
  for (const document of documents) {
    if (!isOfficialShoulderSchedule(document)) continue;
    const text = document.text.replace(/\s+/g, " ");
    if (!/s\s*houl\s*der[\s\S]{0,180}Rating\s+Major\s+Minor/i.test(text)) continue;
    const table = text.match(/\b5201\b([\s\S]*?)(?=\b5202\b|$)/)?.[1];
    if (!table || !/limitation of motion/i.test(table)) continue;
    // Only parse rows actually present in the retrieved official table.
    // These expressions tolerate the existing PDF's split words, not missing
    // qualifiers, columns, or numbers. Never substitute hardcoded percentages.
    const patterns = [
      { degrees: 90, pattern: /flexion and\/or abduction limited t\s*o 90\s*[°º]\s*\)\s*(\d{1,3})\s+(\d{1,3})/i },
      { degrees: 45, pattern: /flexion and\/or abduction limited t\s*o 45\s*[°º]\s*\)\s*(\d{1,3})\s+(\d{1,3})/i },
      { degrees: 25, pattern: /flexion and\/or abduction limited t\s*o 25\s*[°º]\s+fr\s*om side\s+(\d{1,3})\s+(\d{1,3})/i },
    ];
    const rows = patterns.map(({ degrees, pattern }) => {
      const match = table.match(pattern);
      return match ? { degrees, major: Number(match[1]), minor: Number(match[2]) } : null;
    });
    if (rows.some(row => !row || row.major > 100 || row.minor > 100)) continue;
    return { document, rows };
  }
  return null;
}

export function isShoulderMotionCriteriaQuestion(question) {
  if (!isShoulderRatingQuestion(question) ||
      (/\b(?:major|minor|dominant|handedness)\b/i.test(question) &&
        /\b(?:which|mean|define|determine|what is)\b/i.test(question)) ||
      /\b(?:knees?|ankles?|hips?|wrists?|elbows?|spine|lumbar|foot|feet|legs?)\b/i.test(question) ||
      /\b(?:5200|5202|5203|dislocation|ankylosis|clavicle|scapula|replacement|prosthesis|muscle|amputation|fractur\w*|humerus|nonunion|malunion|flail|fibrous union|tendon|tear|rotator cuff|veteran|service connection|line of duty|drill|training)\b/i.test(question)) return false;
  return true;
}

export function shoulderCriteriaAnswer(question, documents) {
  if (!isShoulderMotionCriteriaQuestion(question)) return null;
  const criteria = shoulderMotionCriteria(documents);
  if (!criteria) return null;
  const { document, rows } = criteria;
  const date = document.title?.match(/up to date as of ([\d-]+)/i)?.[1] || document.documentDate;
  const dated = date ? ` The indexed source is dated ${date}; this is not a live check of later amendments.` : "";
  const closing = /\b(?:5201|limited motion|limitation of motion|range of motion|degrees)\b|°/i.test(question)
    ? "These measurements describe the published criteria; they do not establish your individual rating."
    : "Are you asking about limited motion, dislocation, or another shoulder problem?";
  // Keep the criteria and their citation in one complete review unit. Separate
  // uncited table lines otherwise lose their source at sentence-by-sentence audit.
  return `I can't predict your individual VA rating, but I can explain the published criteria in the retrieved schedule.${dated}\n\n**Diagnostic Code 5201 — limitation of arm motion:** for flexion and/or abduction limited to ${rows.map(row => `**${row.degrees}°${row.degrees === 90 ? " (shoulder level)" : row.degrees === 45 ? " (midway between side and shoulder)" : " from the side"}:** major column **${row.major}%**, minor column **${row.minor}%**`).join("; ")} [38 CFR § 4.71a](${document.url}).\n\nThese are criteria for **Code 5201**, not a universal rating range for every shoulder injury [38 CFR § 4.71a](${document.url}). I can't determine which code or percentage applies to your case; VA or an accredited representative can review the relevant medical and functional evidence.\n\n${closing}`;
}
