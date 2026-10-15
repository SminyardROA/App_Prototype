const ADOPTION_URL = "https://www.dfas.mil/MilitaryMembers/payentitlements/adoptionreimbursement/";
const FSA_URL = "https://militarypay.defense.gov/PAY/Allowances/fsa.aspx";
const FSA_DFAS_URL = "https://www.dfas.mil/militarymembers/payentitlements/fsa/";
const BNA_URL = "https://militarypay.defense.gov/Pay/Allowances/bna/";
const BNA_DFAS_URL = "https://www.dfas.mil/MilitaryMembers/payentitlements/bna/";

export function officialAllowanceAnswer(message, year = new Date().getUTCFullYear()) {
  const text = String(message || "");
  if (/\b(?:adoption reimbursement|reimburs\w*.*adoption|adoption.*reimburs\w*)\b/i.test(text)) {
    return {
      text: `Adoption reimbursement is a reimbursement of qualifying expenses, **not a monthly allowance**. DFAS says a member must have at least **180 days of continuous active duty**, the adoption must be finalized while on active duty, and the claim must be filed while on active duty. For claims submitted on or after July 5, 2016, the filing deadline is **within two years of finalization** (one year for older claims). Other conditions and excluded expenses apply; check [DFAS adoption reimbursement](${ADOPTION_URL}) and DoDI 1341.09 with your personnel office. The DFAS page was last updated in 2021, so I can't verify a current ${year} reimbursement maximum from it.`,
      sources: [ADOPTION_URL],
    };
  }
  if (/\b(?:family separation allowance|FSA)\b/i.test(text) &&
      !/\b(?:bna|basic needs allowance)\b/i.test(text)) {
    if (year !== 2026) {
      return { text: `I can't verify a ${year} FSA payment amount. Check the [current DoD FSA guidance](${FSA_URL}) and your unit finance office.`, sources: [FSA_URL] };
    }
    return {
      text: `The current DoD and DFAS pages list **$300 per month** for Family Separation Allowance (FSA), subject to the applicable qualifying separation conditions; it is not automatic merely because a member has dependents. A member generally files DD Form 1561. Check [DoD FSA guidance](${FSA_URL}) and [DFAS FSA guidance](${FSA_DFAS_URL}) for the circumstances and your unit finance office for your case.`,
      sources: [FSA_URL, FSA_DFAS_URL],
    };
  }
  if (/\b(?:basic needs allowance|BNA)\b/i.test(text)) {
    return {
      text: `Basic Needs Allowance (BNA) is a **monthly, means-tested allowance**, not a fixed rate for everyone. DoD describes a household-income threshold tied to **200% of the applicable federal poverty guidelines**, household size, and duty location. DFAS says active-duty Guard and Reserve members on orders can qualify if they have completed initial entry training and have at least one registered dependent; it does **not** state a blanket 180-day active-duty requirement. Both the previous year's gross household income and current annualized income are considered. Your service determines eligibility and the amount. See [DoD BNA guidance](${BNA_URL}) and [DFAS BNA guidance](${BNA_DFAS_URL}); ask your military and family support center or a no-cost financial counselor about applying. Do not share household income in this chat.`,
      sources: [BNA_URL, BNA_DFAS_URL],
    };
  }
  return null;
}