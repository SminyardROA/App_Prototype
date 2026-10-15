// This is a narrow pre-provider safety check, not a comprehensive PII detector.
// Keep it deterministic so rejected inputs never reach embeddings or the model.
function validCardNumber(text) {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let total = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let digit = Number(digits[i]) * (double ? 2 : 1);
    total += digit > 9 ? digit - 9 : digit;
  }
  return total % 10 === 0;
}

export function containsObviousPersonalData(text) {
  if (typeof text !== "string") return false;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return true;
  if (/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/.test(text)) return true;
  if (/(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/.test(text)) return true;
  if (/\b(?:account|acct|routing|member\s*id|claim\s*number)\s*(?:(?:number|no\.?)\s*)?[:#]?\s*[A-Z0-9-]{6,}\b/i.test(text)) return true;
  if (/\b(?:DOB|date of birth)\s*(?:is|:)?\s*\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/i.test(text)) return true;
  return (text.match(/(?:\d[ -]?){13,19}/g) || []).some(validCardNumber);
}