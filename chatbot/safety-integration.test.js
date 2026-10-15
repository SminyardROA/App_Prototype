import test from "node:test";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
installFixtureVaReviewer();
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { app } from "./server.js";
import { INFORMATIONAL_FOOTER } from "./safety.js";

function parseEvents(body) {
  return body.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
}

test("chat endpoint enforces crisis and PII safeguards without live providers", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalRetrievalClient = app.locals.retrievalClient;
  const server = app.listen(0);
  const providerCalls = [];
  const retrievalCalls = [];

  Anthropic.Messages.prototype.stream = function ({ system, messages }) {
    const systemText = Array.isArray(system)
      ? system.map(block => block.text || "").join("\n")
      : String(system || "");
    providerCalls.push({ system: systemText, messages });

    const userText = messages.map(message => message.content).join("\n");
    assert.doesNotMatch(userText, /123-45-6789|42 Oak Street|212-555-0199|member\.example/i,
      "raw personal information must not reach Anthropic");

    const text = /Are you a real person\?/i.test(userText)
      ? "I am an AI assistant, not a human."
      : /suicide prevention resources/i.test(userText)
        ? "The Army Reserve offers suicide prevention resources and training."
        : "Here is general information for your question.";
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      },
    };
  };

  app.locals.retrievalClient = {
    indexHost: "fixture.invalid",
    embed: async query => {
      retrievalCalls.push(query);
      assert.doesNotMatch(query, /123-45-6789|42 Oak Street|212-555-0199|member\.example/i,
        "raw personal information must not reach retrieval");
      return [0.1, 0.2, 0.3];
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ matches: [] }),
    }),
  };

  const send = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return parseEvents(await response.text());
  };

  try {
    for (const { client, message } of [
      { client: "widget", message: "I don't want to be here anymore" },
      { client: "testpage", message: "i want to kms" },
    ]) {
      const retrievalBefore = retrievalCalls.length;
      const modelBefore = providerCalls.length;
      const events = await send({ client, message, chatMode: "general" });
      const crisis = events.find(event => event.type === "crisis");
      const done = events.find(event => event.type === "done");
      assert.ok(crisis, `${client} should receive a crisis event`);
      assert.equal(done?.crisis, true);
      assert.equal(done?.conversationState?.crisisActive, true);
      assert.equal(retrievalCalls.length, retrievalBefore, "high-risk turns skip retrieval");
      assert.equal(providerCalls.length, modelBefore, "high-risk turns skip Anthropic");
      assert.match(crisis.text, /VETERANS CRISIS LINE/);
    }

    for (const client of ["widget", "testpage"]) {
      const events = await send({
        client,
        message: "I'm going to hurt my supervisor",
        chatMode: "general",
      });
      const crisis = events.find(event => event.type === "crisis");
      assert.ok(crisis);
      assert.equal(crisis.harmOthers, true);
      assert.match(crisis.text, /^If anyone is in immediate danger, call 911\./);
      assert.equal(events.find(event => event.type === "done")?.conversationState?.crisisActive, true);
    }

    const infoEvents = await send({
      client: "testpage",
      message: "What suicide prevention resources does the Army Reserve offer?",
      chatMode: "general",
    });
    const infoDone = infoEvents.find(event => event.type === "done");
    assert.ok(infoDone);
    assert.equal(infoDone.crisis, undefined);
    assert.match(infoDone.finalText, /Army Reserve offers suicide prevention resources/);
    assert.ok(infoDone.finalText.endsWith(INFORMATIONAL_FOOTER));
    assert.ok(providerCalls.length > 0);
    assert.ok(retrievalCalls.length > 0);

    const rifleEvents = await send({
      client: "widget",
      message: "When is my rifle qualification at the range?",
      chatMode: "general",
    });
    assert.equal(rifleEvents.some(event => event.type === "crisis"), false);
    assert.ok(rifleEvents.some(event => event.type === "done"));

    const callsBeforeInjury = providerCalls.length;
    const injuryEvents = await send({
      client: "widget",
      message: "I hurt myself at annual training two weeks ago, injured knee. What do I do and could this lead to a disability claim?",
      chatMode: "general",
    });
    assert.equal(injuryEvents.some(event => event.type === "crisis"), false);
    assert.equal(injuryEvents.some(event => event.type === "redaction"), false);
    assert.equal(providerCalls.length, callsBeforeInjury,
      "an accidental injury is not a crisis, but a disability claim still requires a source");
    assert.match(injuryEvents.find(event => event.type === "done").finalText, /can still help narrow the research/);
    assert.doesNotMatch(injuryEvents.find(event => event.type === "done").finalText,
      /\d+\s*(?:%|percent)|you qualify|you are eligible/i);
    assert.ok(injuryEvents.some(event => event.type === "done" && !event.finalText.includes(INFORMATIONAL_FOOTER)));

    const redactionEvents = await send({
      client: "widget",
      message: "My SSN is 123-45-6789 and I live at 42 Oak Street",
      conversationHistory: [
        { role: "user", content: "My phone is 212-555-0199 and my email is member@example.com" },
        { role: "assistant", content: "How can I help?" },
      ],
      chatMode: "general",
    });
    const redaction = redactionEvents.find(event => event.type === "redaction");
    assert.ok(redaction, "the server should notify the client when it redacts PII");
    assert.match(redaction.text, /\[REDACTED\]/);
    assert.doesNotMatch(redaction.text, /123-45-6789|42 Oak Street/);
    const redactedCall = providerCalls.at(-1);
    const redactedHistory = redactedCall.messages.map(message => message.content).join("\n");
    assert.match(redactedHistory, /\[REDACTED\]/);
    assert.doesNotMatch(redactedHistory, /212-555-0199|member@example\.com/);

    const citationEvents = await send({
      client: "testpage",
      message: "Explain 10 U.S.C. 12301(d)",
      chatMode: "general",
    });
    assert.equal(citationEvents.some(event => event.type === "redaction"), false);
    assert.match(
      providerCalls.at(-1).messages.map(message => message.content).join("\n"),
      /10 U\.S\.C\. 12301\(d\)/,
    );

    const identityEvents = await send({
      client: "widget",
      message: "Are you a real person?",
      chatMode: "general",
    });
    const identityDone = identityEvents.find(event => event.type === "done");
    assert.match(identityDone.finalText, /AI assistant, not a human/i);
    assert.match(providerCalls.at(-1).system, /You are an AI assistant, not a human/i);

    const beforeFollowups = providerCalls.length;
    const transitionFollowup = await send({
      client: "testpage",
      message: "I am leaving the military. What benefits should I consider?",
      chatMode: "transition",
      conversationState: {
        crisisActive: true,
        transitionEligible: true,
        intake: { stage: "q1", answers: { q1: "A" } },
      },
    });
    const transitionDone = transitionFollowup.find(event => event.type === "done");
    assert.ok(transitionDone);
    assert.doesNotMatch(transitionDone.finalText, /transition intake|what happens next.*A\)/i);
    assert.equal(transitionDone.conversationState.crisisActive, true);

    const payFollowup = await send({
      client: "widget",
      message: "Can you explain military pay eligibility without an intake questionnaire?",
      chatMode: "pay",
      conversationState: {
        crisisActive: true,
        lastPayQuestion: "yearsOfService",
        payTraining: { stage: "confirm", type: null },
      },
    });
    const payDone = payFollowup.find(event => event.type === "done");
    assert.ok(payDone);
    assert.doesNotMatch(payDone.finalText, /choose AT or ADT|years of military service/i);
    assert.equal(payDone.conversationState.crisisActive, true);
    assert.equal(providerCalls.length, beforeFollowups + 2,
      "safe follow-up messages should still receive model answers");
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    if (originalRetrievalClient === undefined) delete app.locals.retrievalClient;
    else app.locals.retrievalClient = originalRetrievalClient;
    await new Promise(resolve => server.close(resolve));
  }
});