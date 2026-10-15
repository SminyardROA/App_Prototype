import test from "node:test";
import assert from "node:assert/strict";
import { app } from "./server.js";
import { isGeneralVaOpening, VA_OPENING_REPLY } from "./va-opening.js";

test("generic VA inquiries invite a question, not a source refusal", () => {
  for (const text of ["I'm in the Guard/Reserve and have VA disability questions.",
    "I’m in the Guard/Reserve and have VA disability questions",
    "I have VA disability questions", "Can you help me with VA disability claims?",
    "I have questions about VA disability", "I need help with my VA disability claim"]) {
    assert.equal(isGeneralVaOpening(text), true, text);
  }
  for (const text of ["I have VA disability questions about cancer.",
    "Can you help me with VA disability claims? Am I eligible?",
    "I have VA disability questions and want to know what rating I'll get.",
    "Does Guard service qualify me for VA disability?", "What percentage is a shoulder injury?"]) {
    assert.equal(isGeneralVaOpening(text), false, text);
  }
});

test("opening response works without retrieval or a provider; substantive questions still require sources", async () => {
  const original = app.locals.retrievalClient;
  let searches = 0;
  app.locals.retrievalClient = { indexHost: "fixture.invalid",
    embed: async () => { searches++; throw new Error("unavailable"); } };
  const server = app.listen(0);
  const send = async message => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationHistory: [] }),
    });
    return (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).at(-1);
  };
  try {
    const opening = await send("I'm in the Guard/Reserve and have VA disability questions");
    assert.equal(opening.finalText, VA_OPENING_REPLY);
    assert.equal(opening.retrieval.status, "clarification");
    assert.equal(searches, 0);
    const substantive = await send("Does my cancer qualify for VA disability benefits?");
    assert.ok(searches > 0);
    assert.match(substantive.finalText, /unavailable|without.*source/i);
    const crisis = await send("I have VA disability questions and want to kill myself");
    assert.equal(crisis.crisis, true);
  } finally { app.locals.retrievalClient = original; await new Promise(resolve => server.close(resolve)); }
});
