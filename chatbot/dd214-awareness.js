export const DD214_AWARENESS_QUESTION = "Before we continue, do you know what a DD Form 214-1 is and why it can be important to your benefits now and in the future?\nA) Yes\nB) No\nC) I am not sure.";

export function volunteeredDd214Awareness(text) {
  if (typeof text !== "string" ||
      /\b(?:hypothetically|suppose|what if|for example|my friend)\b/i.test(text)) return null;
  const form = "DD\\s*(?:Form\\s*)?214[\\s-]*1\\b";
  if (new RegExp("\\b(?:I (?:do not|don't) know|I(?:'m| am) not (?:aware|familiar|sure))[^.!?\\n]{0,60}" + form, "i").test(text)) return false;
  if (new RegExp("\\b(?:I (?:already )?(?:know|understand)|I(?:'m| am) (?:already )?(?:aware|familiar))[^.!?\\n]{0,60}" + form, "i").test(text)) return true;
  return null;
}

function isAwarenessQuestion(text) {
  return /\bDD\s*(?:Form\s*)?214[\s-]*1\b/i.test(text) &&
    /\b(?:do you know|are you aware|have you heard|are you familiar|know what|familiar with|aware of)\b/i.test(text) &&
    /\?/.test(text);
}

// Prefer the state returned by the server, with legacy client/history recovery.
export function resolveDd214State(conversation, requestedState, history = []) {
  const valid = value => ["awareness_asked", "review_offered", "completed"].includes(value);
  const saved = conversation.dd214PathwayState;
  const priorQuestion = history.some(turn => turn.role === "assistant" && isAwarenessQuestion(String(turn.content || "")));
  const asked = conversation.dd214AwarenessAsked === true || valid(saved) ||
    valid(requestedState) || priorQuestion;
  conversation.dd214AwarenessAsked = asked;
  return valid(saved) ? saved : valid(requestedState) ? requestedState :
    asked ? "awareness_asked" : "not_started";
}

// Final-answer guard: don't expose a repeated awareness question or its options.
// Keep ordinary explanations and member-requested DD214-1 answers intact.
export function removeRepeatedDd214Awareness(text) {
  return String(text).split(/\n\s*\n/).map(paragraph => {
    if (!isAwarenessQuestion(paragraph)) return paragraph;
    return paragraph.replace(/[^.!?\n]*\b(?:do you know|are you aware|have you heard|are you familiar|know what|familiar with|aware of)\b[^?]*\?\s*(?:\n?[A-C][).]\s*(?:Yes|No|I am not sure)[^\n]*\s*)*/gi, "").trim();
  }).filter(Boolean).join("\n\n");
}
