// Build a search query, not a transcript. The model still receives the full
// conversational history separately when generating its response.
export function buildRetrievalQuery(message, history = [], conversation = null,
  { offPathway = false, includePayFacts = false } = {}) {
  const latest = String(message || "").trim();
  if (offPathway) return latest;
  const parts = [latest];
  const shortFollowUp = latest.split(/\s+/).length < 12 ||
    /\b(?:that|this|those|what about|and if|what if|same|previous)\b/i.test(latest) ||
    /^[A-D](?:[).:-])?$/i.test(latest);
  if (shortFollowUp) {
    const previousUser = [...history].reverse().find(turn => turn.role === "user");
    const previousAssistant = [...history].reverse().find(turn => turn.role === "assistant");
    if (previousUser) parts.push(`Previous user question: ${String(previousUser.content).trim().slice(-240)}`);
    if (previousAssistant) parts.push(`Previous reply (excerpt): ${String(previousAssistant.content).trim().slice(-300)}`);
  }

  if (!includePayFacts) return parts.join("\n");
  const userText = history.filter(turn => turn.role === "user").slice(-12)
    .map(turn => String(turn.content || "")).join(" ");
  const facts = [];
  const grade = [...userText.matchAll(/\b(?:E|O|W)-\d{1,2}\b/gi)].at(-1)?.[0];
  if (grade) facts.push(`grade ${grade.toUpperCase()}`);
  if (Number.isInteger(conversation?.serviceYears)) facts.push(`${conversation.serviceYears} years of service`);
  if (conversation?.payTraining?.type) facts.push(`orders ${conversation.payTraining.type}`);
  const order = [...userText.matchAll(/\b(?:Title\s+(?:10|32)|annual training|mobilization|ADT|IDT|\d{1,3}[- ]day orders?)\b/gi)]
    .at(-1)?.[0];
  if (order && !facts.some(fact => fact.toLowerCase().includes(order.toLowerCase()))) facts.push(`orders ${order}`);
  if (facts.length) parts.push(`Known pay facts: ${facts.join("; ")}`);
  return parts.join("\n");
}