export const VA_OPENING_REPLY =
  "Sure. What would you like help researching—starting a claim, understanding rating criteria, reviewing a decision, or something else? You can describe your question in general terms; please leave out personal identifiers.";

// A small, anchored set of conversational openers—not a general exemption
// for VA questions. Appended conditions, eligibility questions and facts do
// not match and must still go through retrieval and claim verification.
export function isGeneralVaOpening(message) {
  let text = String(message || "").replace(/[’‘]/g, "'").trim().replace(/[.!?]+$/, "").trim();
  text = text.replace(/^(?:I'm|I am)\s+(?:in\s+)?(?:the\s+)?(?:Guard\s*\/\s*Reserve|Guard or Reserve|National Guard|Guard|Reserves?)\s+and\s+/i, "");
  return /^(?:(?:I\s+)?have\s+(?:some\s+)?VA disability questions|(?:I\s+)?(?:need|want)\s+help with VA disability(?: claims?| questions)?|can you help (?:me )?with VA disability(?: claims?| questions)?)$/i.test(text) ||
    /^(?:I have (?:a question|questions) about|I'd like to ask about|can I ask about|I need (?:some )?help with)\s+(?:my\s+)?VA (?:disability(?: claims?| benefits?)?|benefits?|claims?)$/i.test(text);
}
