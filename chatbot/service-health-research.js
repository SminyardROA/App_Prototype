// Query interpretation only. A research lead is not proof of exposure,
// qualifying service, diagnosis, or entitlement.
export const VIETNAM_TOPIC = /\b(?:Vietnam|Viet Nam)\b/i;
export const HERBICIDE_TOPIC = /\b(?:Agent Orange|herbicides?)\b/i;
export const LUNG_CANCER_TOPIC = /\b(?:(?:lung|respiratory)\s+cancers?|cancer\s+of\s+(?:the\s+)?(?:lung|bronchus|larynx|trachea))\b/i;
const HEALTH_TOPIC = /\b(?:cancers?|carcinoma|malignan\w*|lymphoma|leukemia|diabetes|Parkinson'?s?|neuropath\w*|ischemic heart|respirator\w*|lungs?|breath\w*|asthma|bronch\w*|sinusitis|rhinitis|PTSD|tinnitus|sleep apnea|headaches?|injur\w*)\b/i;
const SERVICE_TOPIC = /\b(?:Vietnam|Viet Nam|veterans?|military|Army|Navy|Marines?|Marine Corps|Air Force|Coast Guard|Space Force|National Guard|Reserv(?:e|es|ist)|active duty|deployed)\b/i;

export function isServiceHealthStatement(text) {
  return SERVICE_TOPIC.test(String(text || "")) && HEALTH_TOPIC.test(String(text || ""));
}

export function isHerbicideResearch(text) {
  const value = String(text || "");
  return HERBICIDE_TOPIC.test(value) || (VIETNAM_TOPIC.test(value) &&
    (HEALTH_TOPIC.test(value) || /\b(?:VA|disability|claims?|benefits?|presumpti\w*)\b/i.test(value)));
}

export function herbicideSearchQuery(text) {
  return `${text}\nResearch possible Vietnam herbicide Agent Orange exposure and presumptive disease rules: 38 CFR 3.307(a)(6), 3.309(e); 38 USC 1116. Respiratory cancers include cancer of the lung, bronchus, larynx, or trachea. Check actual service location and dates; do not assume eligibility.`;
}
