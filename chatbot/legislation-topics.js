// Accept the conversational shorthand and the full title printed on the
// congressional testimony. Names identify a topic, never enactment.
export const SUSAN_LUKAS_TOPIC =
  /\bSusan(?:\s+E\.?)?\s+Lu[ck]as(?:\s+9\/11\s+Servicemember\s+Fairness)?\s+Act\b/i;

const september11 = String.raw`(?:9[/-]11|Sept?(?:ember)?\.?\s+11(?:th)?|11(?:th)?\s+Sept?(?:ember)?\.?)`;
export const PENTAGON_911_EXPOSURE = new RegExp(
  String.raw`(?:\bPentagon\b[^\n!?]{0,100}\b${september11}\b|\b${september11}\b[^\n!?]{0,100}\bPentagon\b)`, "i",
);

// This is a research association, not a finding of exposure, diagnosis,
// qualifying service, or entitlement under either proposed or existing law.
export function isPentagon911HealthQuestion(question) {
  const text = String(question || "");
  return PENTAGON_911_EXPOSURE.test(text) &&
    /\b(?:respirator\w*|breath\w*|asthma|lungs?|bronch\w*|cancers?|illness|diseases?|medical|health|symptoms?|toxic|exposure|presumpt\w*|disabilit\w*|claims?)\b/i.test(text);
}

export function isSusanLukasResearchQuestion(question) {
  return SUSAN_LUKAS_TOPIC.test(String(question || "")) || isPentagon911HealthQuestion(question);
}
