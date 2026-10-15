// Official statutory references:
// Official current U.S. Code; the bare granuleid URL returns Document not Found.
export const SCRA_LEASE_URL = "https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3955%20edition%3Aprelim%29";
export const SCRA_SERVICE_URL = "https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3911%20edition%3Aprelim%29";
export const SCRA_INTEREST_URL = "https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3937%20edition%3Aprelim%29";

export function isScraQuestion(message) {
  return /\bSCRA\b|Servicemembers Civil Relief|\b(?:military|Guard|Reserve|orders|activat\w*|mob(?:ilization)?)\b[\s\S]{0,100}\b(?:lease|landlord|rent|rental agreement|loan interest)\b|\b(?:lease|landlord|rent|rental agreement)\b[\s\S]{0,100}\b(?:military|Guard|Reserve|orders|activat\w*|mob(?:ilization)?)\b/i.test(message);
}

const leaseTerms = /\b(?:leases?|rental agreements?|landlord)\b/i;
const beforeService = /\b(?:before|prior to)\b[\s\S]{0,65}\b(?:service|duty|activat|mobiliz|orders)\b|\b(?:service|duty|activat|mobiliz|orders)\b[\s\S]{0,65}\b(?:before|prior to)\b|\bpre[- ](?:service|duty)\b/i;
const duringService = /\b(?:during|while|after entering|after starting|in)\s+(?:military\s+|active\s+)?service\b|\b(?:during|while)\s+on\s+(?:active\s+)?duty\b/i;
const afterEnteringService = /\bafter\s+(?:entering|joining|starting)\s+(?:military\s+|active\s+)?(?:service|duty)\b/i;
const pcsOrDeployment = /\b(?:PCS|permanent change of station|deploy(?:ment|ed)?)(?:\s+orders)?\b/i;

function supportedLeasePaths(documents) {
  const paths = { before: null, during: null };
  for (const doc of documents) {
    if (!/^https?:\/\/(?:www\.)?roa\.org\//i.test(doc.url || "") || !leaseTerms.test(doc.text || "") ||
        !/\b(?:SCRA|servicemembers civil relief|3955)\b/i.test(`${doc.title || ""} ${doc.text || ""}`) ||
        !/\bterminat(?:e|ion|ing)\b/i.test(doc.text || "")) continue;
    // Test the article's text, not its title or a neighboring retrieved chunk.
    if (beforeService.test(doc.text) && !paths.before) paths.before = doc.url;
    if (duringService.test(doc.text) && pcsOrDeployment.test(doc.text) && !paths.during) paths.during = doc.url;
  }
  return paths;
}

function leaseClarification(lawCenterOnly, sourceDocuments) {
  if (lawCenterOnly) {
    const paths = supportedLeasePaths(sourceDocuments);
    const rules = [];
    if (paths.before) rules.push(`A lease entered before military service may be covered, subject to the other conditions in the [Law Center article](${paths.before}).`);
    if (paths.during) rules.push(`A lease entered during service may also be covered following qualifying PCS or deployment orders, as described in the [Law Center article](${paths.during}).`);
    return `${rules.length ? rules.join(" ") + " " : "The supplied Reserve Service Law Center articles do not establish the lease rule needed to decide this. "}Receiving orders alone does not establish your eligibility. When did you enter service and sign the lease, and what are the authority, duration, purpose, and any PCS or deployment terms of your orders? Confirm the details with military legal assistance; if the articles do not address your situation, try the [Full ReserveConnect Navigator](/).`;
  }
  return `Under [50 U.S.C. § 3955](${SCRA_LEASE_URL}), a residential lease entered before military service is one possible path; a lease entered during service followed by qualifying PCS or deployment orders is another. Neither path establishes your eligibility from orders alone. When did you enter service and sign the lease, and what are the authority, duration, purpose, and any PCS or deployment terms of your orders? For Title 32 service, [50 U.S.C. § 3911](${SCRA_SERVICE_URL}) has additional conditions; federal funding alone is not enough. Confirm your situation with military legal assistance.`;
}

export function finalizeScraAnswer(text, question, { lawCenterOnly = false, sourceDocuments = [] } = {}) {
  if (!isScraQuestion(question)) return text;
  const plainText = text.replace(/[*_]/g, "");
  const leaseQuestion = leaseTerms.test(question) && /\b(?:terminat(?:e|es|ed|ing|ion)|cancel(?:led|ing|ed|ation)?|break|end|rights?|SCRA|orders|mob|deploy|PCS)\b/i.test(question);
  const leaseSentences = plainText.split(/(?<=[.!?])\s+|\n+/).filter(sentence => leaseTerms.test(sentence));
  const preServiceOnly = leaseQuestion && leaseSentences.some(sentence =>
    (/\b(?:must|have to|need to|required to|only|solely)\b/i.test(sentence) && beforeService.test(sentence) &&
      !(duringService.test(sentence) && pcsOrDeployment.test(sentence))) ||
    (/\b(?:cannot|can't|not eligible|doesn't qualify|don't qualify)\b[\s\S]{0,90}\b(?:during|while)\s+(?:military\s+|active\s+)?service\b/i.test(sentence) ||
      /\b(?:during|while)\s+(?:military\s+|active\s+)?service\b[\s\S]{0,90}\b(?:cannot|can't|not eligible|doesn't qualify|don't qualify)\b/i.test(sentence) ||
      (afterEnteringService.test(sentence) && /\b(?:cannot|can't|not eligible|doesn't qualify|don't qualify)\b/i.test(sentence))));
  const categoricalEntitlement = leaseQuestion && leaseSentences.some(sentence =>
    /\b(?:you|your orders|this service|title\s*32|guard)\b[\s\S]{0,85}\b(?:can|may|qualif(?:y|ies)|eligible|entitled|permit(?:s)?|allows?|lets?|give(?:s)?\s+you\s+(?:the\s+)?right\s+to)\b[\s\S]{0,85}\b(?:terminat|cancel|break|end|lease)\b|\b(?:you|your orders|title\s*32|guard)\b[\s\S]{0,65}\b(?:qualif(?:y|ies)|eligible|entitled)\b/i.test(sentence) &&
    !/\b(?:whether|might|could|depending|depends|subject to|does not|do not|not qualify|not eligible)\b/i.test(sentence) &&
    !/\b(?:if|only when|provided that)\b[\s\S]{0,100}\b(?:qualifying orders|orders qualify|orders meet|service qualifies|service meets|duty qualifies|duty meets|eligible service|qualifying service|qualifying deployment|qualifying PCS)\b/i.test(sentence));
  const paths = lawCenterOnly && leaseQuestion ? supportedLeasePaths(sourceDocuments) : null;
  const unsupportedArticleClaim = paths && leaseSentences.some(sentence =>
    (beforeService.test(sentence) && !paths.before) ||
    (duringService.test(sentence) && pcsOrDeployment.test(sentence) && !paths.during) ||
    (/\b(?:you can|you may|eligible|entitled|qualifies)\b/i.test(sentence) && !paths.before && !paths.during));
  if (preServiceOnly || categoricalEntitlement || unsupportedArticleClaim) {
    return leaseClarification(lawCenterOnly, sourceDocuments);
  }
  // Do not silently change a legal citation or let an incorrect claim appear
  // as a model-verified answer. Suppress the answer and give verified pointers.
  const wrongLeaseCitation =
    /\b(?:50\s+U\.?S\.?C\.?\s*(?:§|section)?\s*3956|(?:§|section)\s*3956)\b/i.test(plainText) &&
    /\b(?:lease|landlord|rent)\b/i.test(plainText);
  const blanketGuardExclusion =
    /\b(?:Title\s*32|32\s+U\.?S\.?C\.?)[\s\S]{0,160}\b(?:generally\s+)?(?:(?:does|do|is|are)\s+not|doesn't|don't|isn't|aren't|cannot|not|never)\s+(?:apply|qualify|cover(?:ed)?|eligible|protected|included)\b/i.test(plainText) ||
    /\b(?:Title\s*32|32\s+U\.?S\.?C\.?)[\s\S]{0,120}\b(?:ineligible|excluded)\b/i.test(plainText) ||
    /\bSCRA[\s\S]{0,100}\b(?:only|exclusively)\s+(?:applies|covers)\s+(?:to\s+)?Title\s*10\b/i.test(plainText) ||
    /\b(?:only|exclusively)\s+Title\s*10\b[\s\S]{0,80}\b(?:qualif|cover|SCRA)/i.test(plainText);
  // Federal funding alone never establishes the limited Title 32 coverage.
  // Require a positive "alone is enough" claim, rather than flagging the word
  // "alone" in the correct statement "funding alone is not sufficient".
  const fundingClaims = plainText.match(/[^.!?\n]*\b(?:federal(?:ly)?\s+fund(?:ed|ing)|fund(?:ed|ing)\s+by\s+the\s+federal\s+government)\b[^.!?\n]*/gi) || [];
  const fundingAloneInclusion = /\b(?:guard|title\s*32)\b/i.test(question) && fundingClaims.some(claim =>
    /\b(?:alone|by itself|on its own)\s+(?:(?:is|are)\s+)?(?:enough|sufficient|qualif(?:y|ies)|cover(?:ed|s)?|eligible|appl(?:y|ies))\b/i.test(claim));
  if (!wrongLeaseCitation && !blanketGuardExclusion && !fundingAloneInclusion) return text;
  if (lawCenterOnly) return leaseClarification(true, sourceDocuments);
  return `I can't verify the SCRA citation or National Guard eligibility statement in the draft answer, so I won't rely on it. Under 50 U.S.C. § 3955 (${SCRA_LEASE_URL}), a residential lease entered before military service is one possible path; a lease entered during service followed by qualifying PCS or deployment orders is another. The interest limit on debts incurred before military service is in 50 U.S.C. § 3937 (${SCRA_INTEREST_URL}). Under 50 U.S.C. § 3911 (${SCRA_SERVICE_URL}), qualifying Title 32 § 502(f) National Guard duty can be covered when authorized by the President or Secretary of Defense for more than 30 consecutive days to respond to a President-declared national emergency and supported by federal funds. Federal funding alone is not sufficient for routine duty that lacks those conditions. Neither orders alone nor the lease date alone establishes your eligibility. Check the authority, duration, emergency purpose, and funding on your orders, as well as the lease and debt dates, with a military legal assistance attorney before acting.`;
}