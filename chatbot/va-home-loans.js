// Verified against the VA pages below. Keep this narrow: it covers
// service-based COE eligibility, not underwriting or every loan situation.
export const VA_LOAN_ELIGIBILITY_URL = "https://www.va.gov/housing-assistance/home-loans/eligibility/";
export const VA_LOAN_COE_GUIDE_URL = "https://www.va.gov/housing-assistance/home-loans/how-to-request-coe/";
export const VA_LOAN_COE_FORM_URL = "https://www.va.gov/housing-assistance/home-loans/request-coe-form-26-1880";

export function isVaHomeLoanServiceQuestion(message) {
  const text = String(message || "");
  return /\b(?:va|veterans affairs)\b/i.test(text) &&
    /\b(?:home|housing|mortgage)?\s*loans?\b|\b(?:coe|certificate of eligibility)\b/i.test(text) &&
    /\b(?:qualif(?:y|ication)|eligib(?:le|ility)|service|guard|reserve|retir|veteran|coe|certificate|home loan)\b/i.test(text);
}

export function vaHomeLoanServiceAnswer(message, history = []) {
  const recentMemberContext = history.filter(turn => turn?.role === "user")
    .slice(-3).map(turn => String(turn.content || "")).join(" ");
  const greyArea = /\bgr[ae]y area\b/i.test(`${recentMemberContext} ${message}`);
  const opening = greyArea
    ? "Being a Grey Area retiree with 20 years of Guard or Reserve service does not, by itself, establish VA home-loan eligibility. Your qualifying service and status matter."
    : "You may qualify for a VA home loan, but VA must confirm your service-based eligibility.";

  return `${opening}

For **National Guard members**, VA lists a path based on **6 creditable years** if you still serve, were discharged honorably, or were placed on the retired list. VA also lists **at least 90 days of non-training Title 10 active duty**, or **at least 90 days of qualifying Title 32 active service including 30 consecutive days** under the listed 32 U.S.C. authorities. For **Reserve members**, VA lists **6 creditable years in the Selected Reserve** with the same serving, honorable-discharge, or retired-list conditions, or **at least 90 days of non-training active-duty service**. Do not apply a generic wartime/peacetime day-count checklist to every Guard or Reserve case; VA's requirements can also depend on the service period. [VA home-loan eligibility by service](${VA_LOAN_ELIGIBILITY_URL}).

To check your own record, request a **Certificate of Eligibility (COE)**. VA explains which service and retirement records Guard and Reserve members may need in its [COE document guide](${VA_LOAN_COE_GUIDE_URL}). You can [request a COE from VA](${VA_LOAN_COE_FORM_URL}); VA reviews your record, and a lender separately evaluates credit, income, and occupancy. If you tell me whether you served in the National Guard or Selected Reserve, whether your years were creditable, and whether you're on the retired list, I can help you identify the likely service-based path without promising a decision.`;
}

export const VA_LOAN_SOURCES = [
  VA_LOAN_ELIGIBILITY_URL,
  VA_LOAN_COE_GUIDE_URL,
  VA_LOAN_COE_FORM_URL,
];