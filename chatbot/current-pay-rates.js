// Official annual rates verified against the public DoD BAS and DFAS BAS pages.
// Do not silently carry a prior year's amounts forward. Refresh and verify this
// record when DoD publishes the next year's figures.
export const verifiedBas = Object.freeze({
  year: 2026,
  officer: 328.48,
  enlisted: 476.95,
  source: "https://militarypay.defense.gov/PAY/allowances/bas.aspx",
});

// DoD July 2026 IDT-TRP information paper, applying JTR paragraph 032304.
// This is a policy reimbursement cap per round trip, NOT an annual pay rate.
export const verifiedIdtTravelCap = Object.freeze({
  year: 2026,
  amount: 750,
  source: "https://media.defense.gov/2026/Jul/30/2003972100/-1/-1/1/INACTIVE%20DUTY%20TRAINING%20(IDT)%2007-29-26.PDF",
});

export function isCurrentIdtTravelCapQuestion(message, year = new Date().getUTCFullYear()) {
  const text = String(message || "");
  const requestedYears = [...text.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  return !requestedYears.some(requested => requested !== year) &&
    /\b(?:IDT|inactive duty training|drill)\b/i.test(text) &&
    /\b(?:travel|commut|reimburs)/i.test(text) &&
    /\b(?:cap|limit|maximum|max|up to|how much|750|per month|monthly|round trip)\b/i.test(text);
}

export function currentIdtTravelCapAnswer(year = new Date().getUTCFullYear()) {
  if (verifiedIdtTravelCap.year !== year) {
    return {
      text: `I can't verify the ${year} IDT travel reimbursement cap. Check the current [Joint Travel Regulations](https://www.travel.dod.mil/Policy-Regulations/Joint-Travel-Regulations/) and your service's IDT travel policy before relying on a figure.`,
      sources: [],
    };
  }
  return {
    text: `The DoD's ${year} IDT travel guidance describes a reimbursement cap of **$${verifiedIdtTravelCap.amount} per round trip**, not per month. IDT travel reimbursement is a discretionary program with eligibility, distance, funding, and service-specific requirements; the cap does not mean every member qualifies or receives that amount. See [DoD IDT travel guidance](${verifiedIdtTravelCap.source}) and JTR paragraph 032304.`,
    sources: [verifiedIdtTravelCap.source],
  };
}

export function isCurrentBasRateQuestion(message, year = new Date().getUTCFullYear()) {
  const text = String(message || "");
  if (!/\b(?:BAS|basic allowance for subsistence)\b/i.test(text)) return false;
  if (!/\b(?:rate|amount|how much|per month|monthly|dollars?|table|202\d)\b/i.test(text)) return false;
  const requestedYears = [...text.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  return requestedYears.length === 0 || requestedYears.every(requested => requested === year);
}

export function currentBasAnswer(year = new Date().getUTCFullYear()) {
  if (verifiedBas.year !== year) {
    return {
      text: `I can't verify the ${year} BAS rates from a current official source. Please check the [DoD BAS rates](${verifiedBas.source}) or [DFAS BAS table](https://www.dfas.mil/MilitaryMembers/payentitlements/Pay-Tables/bas/) before relying on a figure.`,
      sources: [],
    };
  }
  return {
    text: `The ${year} Basic Allowance for Subsistence (BAS) rates are **$${verifiedBas.officer.toFixed(2)}/month for officers** and **$${verifiedBas.enlisted.toFixed(2)}/month for enlisted members**. These are standard BAS rates, not a determination of your individual entitlement. [DoD BAS rates](${verifiedBas.source}); [DFAS BAS table](https://www.dfas.mil/MilitaryMembers/payentitlements/Pay-Tables/bas/).`,
    sources: [verifiedBas.source, "https://www.dfas.mil/MilitaryMembers/payentitlements/Pay-Tables/bas/"],
  };
}

export function isCurrentPayRateQuestion(message, year = new Date().getUTCFullYear()) {
  const text = String(message || "");
  const requestedYears = [...text.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  if (requestedYears.some(requested => requested !== year)) return false;
  // Limits and reimbursement ceilings are policy rules, not annual pay rates.
  if (/\b(?:cap|ceiling|limit|maximum|max|up to)\b/i.test(text)) return false;
  return /\b(?:pay|allowance|BAH|BAS|drill|per diem|subsistence|housing)\b/i.test(text) &&
    /\b(?:rate|amount|how much|per month|monthly|dollars?|table|20\d{2})\b/i.test(text);
}

// A current-year mention elsewhere in the knowledge base is not proof of a
// current rate. Require the year and a dollar figure in the same official chunk.
export function hasCurrentYearRateEvidence(documents, year = new Date().getUTCFullYear()) {
  return (documents || []).some(doc =>
    /^https:\/\/(?:www\.)?(?:dfas\.mil|militarypay\.defense\.gov|travel\.dod\.mil)\//i.test(doc.url || "") &&
    new RegExp(`\\b${year}\\b`).test(doc.text || "") &&
    /\$\s?\d[\d,]*(?:\.\d{2})?/.test(doc.text || "")
  );
}