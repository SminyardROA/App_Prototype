import test from "node:test";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
installFixtureVaReviewer();
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { app } from "./server.js";
import {
  newTransitionIntake, rememberTransitionAnswers, advanceTransitionIntake,
  transitionGuidance,
} from "./transition-intake.js";
import {
  rememberPayFacts, sanitizePayFacts, nextMissingPayQuestion, parseServiceYears,
  PAY_LOCATION_QUESTION, PAY_YEARS_QUESTION, PAY_OTHER_CIRCUMSTANCES_QUESTION,
} from "./pay-training-intake.js";
import { volunteeredDd214Awareness, DD214_AWARENESS_QUESTION } from "./dd214-awareness.js";

test("retiring in six months skips departure type and timing without assuming retired-pay eligibility", () => {
  for (const timing of ["6 months", "six months"]) {
    const state = advanceTransitionIntake(newTransitionIntake(), `I am retiring in ${timing}`);
    assert.equal(state.stage, "q3");
    assert.deepEqual(state.answers, { q1: "retiring", q2: "A", q3: null });
    assert.match(transitionGuidance({ ...state, stage: "completed", answers: { ...state.answers, q3: "B" } }),
      /Immediate-pay versus Grey Area retirement is NOT established/);
  }
});

test("multiple volunteered transition facts fill future questions and persist during DD214 awareness", () => {
  const saved = rememberTransitionAnswers(newTransitionIntake(),
    "I am retiring in 6 months. My biggest concern is health insurance.");
  assert.equal(saved.stage, "not_started");
  assert.deepEqual(saved.answers, { q1: "retiring", q2: "A", q3: "B" });
  assert.equal(advanceTransitionIntake(saved, "Yes").stage, "completed");
});

test("transition ignores assistant examples, third parties, hypothetical questions and ambiguous priorities", () => {
  const history = [{ role: "assistant", content: "For example: I am retiring in 6 months." }];
  const initial = newTransitionIntake();
  for (const message of [
    "My friend is retiring in 6 months.", "What if I am retiring in 6 months?",
    "Can I retire in 6 months?", "I am not retiring in 6 months.",
  ]) assert.equal(rememberTransitionAnswers(initial, message, history), initial);
  const state = rememberTransitionAnswers(initial,
    "I am retiring in 6 months. My biggest concern is health insurance and employment.");
  assert.equal(state.answers.q3, null);
});

test("recorded transition choices outrank old history and explicit current corrections win", () => {
  const state = { stage: "q3", answers: { q1: "C", q2: "B", q3: null } };
  const history = [{ role: "user", content: "I am retiring with immediate pay in 6 months." }];
  assert.equal(rememberTransitionAnswers(state, "Health insurance", history), state);
  const corrected = rememberTransitionAnswers(state,
    "Actually I am retiring with immediate pay in 3 months.", history);
  assert.equal(corrected.answers.q1, "B");
  assert.equal(corrected.answers.q2, "A");
  const distant = advanceTransitionIntake(newTransitionIntake(), "I am retiring in 3 years.");
  assert.equal(distant.stage, "q3");
  assert.equal(distant.answers.q2, "months:36");
});

test("volunteered pay facts skip grade, location, service years and dependents together", () => {
  const facts = rememberPayFacts({},
    "I am E-5 with 7 years of service. I am CONUS. I have no dependents. I am on annual training.");
  assert.deepEqual(facts, { grade: "E-5", years: 7, location: "CONUS", hasDependents: false, trainingType: "AT" });
  assert.equal(nextMissingPayQuestion(facts), PAY_OTHER_CIRCUMSTANCES_QUESTION);
  assert.equal(nextMissingPayQuestion({ grade: "E-5" }), PAY_LOCATION_QUESTION);
  assert.equal(nextMissingPayQuestion({ grade: "E-5", location: "CONUS" }), PAY_YEARS_QUESTION);
  assert.equal(nextMissingPayQuestion({ ...facts, otherKnown: true }), null);
});

test("pay facts do not mistake order lengths, dependents or examples for service years", () => {
  for (const message of [
    "I have 2 dependents.", "I have 14 days of orders.", "My friend is E-5 with 7 years of service.",
    "What if I am E-5 with 7 years of service?", "What does an E-5 earn?",
  ]) assert.equal(rememberPayFacts({}, message).years, undefined, message);
  assert.deepEqual(rememberPayFacts({}, "Thanks", [
    { role: "assistant", content: "I am E-5 with 7 years of service." },
  ]), {});
  assert.deepEqual(parseServiceYears("I have 7 years of service"), { kind: "years", value: 7 });
  assert.equal(parseServiceYears("I have 2 dependents").kind, "invalid");
  assert.deepEqual(sanitizePayFacts({ grade: "E-99", years: 90, email: "example", hasDependents: false }),
    { hasDependents: false });
});

test("current pay corrections override recorded inputs; recorded inputs override older statements", () => {
  const history = [{ role: "user", content: "I am E-5 with 7 years of service. I am CONUS." }];
  const facts = { grade: "E-6", years: 9, location: "OCONUS" };
  assert.deepEqual(rememberPayFacts(facts, "Thanks", history), facts);
  assert.equal(rememberPayFacts(facts, "Actually I am E-7.", history).grade, "E-7");
});

test("explicit DD214-1 awareness answers count, but ordinary DD214 and hypothetical references do not", () => {
  assert.equal(volunteeredDd214Awareness("I already know what DD Form 214-1 is."), true);
  assert.equal(volunteeredDd214Awareness("I don't know what a DD214-1 is."), false);
  assert.equal(volunteeredDd214Awareness("I'm familiar with DD214-1."), true);
  assert.equal(volunteeredDd214Awareness("I'm not sure what DD214-1 is."), false);
  for (const text of ["I know what a DD214 is.", "My friend knows DD214-1.", "What if I know DD214-1?"])
    assert.equal(volunteeredDd214Awareness(text), null);
});

async function send(server, message, extras = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...extras }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  const done = events.findLast(event => event.type === "done");
  assert.ok(done, JSON.stringify(events));
  return done;
}

test("chat saves the opening six-month retirement facts before DD214 and asks only the missing concern", async () => {
  const server = app.listen(0);
  try {
    const first = await send(server, "I am retiring in 6 months.", { chatMode: "transition" });
    assert.equal(first.finalText, DD214_AWARENESS_QUESTION);
    assert.deepEqual(first.conversationState.intake.answers, { q1: "retiring", q2: "A", q3: null });
    const second = await send(server, "A", { chatMode: "transition", conversationState: first.conversationState });
    assert.match(second.finalText, /biggest concern/);
    assert.doesNotMatch(second.finalText, /how.*leaving|roughly when|Which of these best describes/i);
    assert.equal(second.conversationState.intake.stage, "q3");
    const natural = await send(server, "I'm already familiar with DD214-1.",
      { chatMode: "transition", conversationState: first.conversationState });
    assert.match(natural.finalText, /biggest concern/);
    const aware = await send(server, "I am retiring in 6 months. I already know what DD Form 214-1 is.",
      { chatMode: "transition" });
    assert.match(aware.finalText, /biggest concern/);
    assert.doesNotMatch(aware.finalText, /do you know|roughly when/i);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("server-owned training and service-years questions skip volunteered answers", async () => {
  const server = app.listen(0);
  try {
    const first = await send(server, "B", { chatMode: "pay", conversationHistory: [
      { role: "user", content: "I am E-5 with 7 years of service. I am CONUS. I have no dependents. I am on annual training." },
      { role: "assistant", content: "Which of these best describes your current situation?\nA) I am drilling\nB) I am on orders for Annual Training" },
    ] });
    assert.equal(first.finalText, PAY_OTHER_CIRCUMSTANCES_QUESTION);
    assert.equal(first.conversationState.payTraining.stage, "later");
    const years = await send(server, "I have 7 years of service. I have no dependents.", {
      chatMode: "pay", conversationHistory: [{ role: "assistant", content: PAY_YEARS_QUESTION }],
    });
    assert.equal(years.finalText, PAY_OTHER_CIRCUMSTANCES_QUESTION);
    assert.equal(years.conversationState.serviceYears, 7);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("all six modes receive the skip-known-facts rule without weakening source restrictions or caching member facts", async () => {
  const originalStream = Anthropic.Messages.prototype.stream;
  const originalClient = app.locals.retrievalClient;
  let request;
  Anthropic.Messages.prototype.stream = options => {
    request = options;
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Which specific resource would you like help with?" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid", embed: async () => [0.1],
    fetch: async () => ({ ok: true, json: async () => ({ matches: [{
      id: "member-resource", score: 0.95,
      metadata: { url: "https://roa.org/wp-content/uploads/2025/12/23033-LR.pdf", title: "Member resource fixture",
        text: "Reserve Service Law Center member resources and military benefits guidance." },
    }] }) }),
  };
  const server = app.listen(0);
  try {
    for (const chatMode of Object.keys(config.chatModes)) {
      request = null;
      await send(server, "Which member resources can I use?", { chatMode, conversationHistory: [
        { role: "user", content: "I am E-5 with 7 years of service. I have no dependents." },
      ] });
      assert.ok(request, `${chatMode} should reach the model`);
      const shared = request.system.find(block => block.cache_control);
      assert.match(shared.text, /CURATED PATHWAY INPUTS.*EVERY SEARCH MODE/);
      assert.match(shared.text, /Skip every question already answered/);
      assert.doesNotMatch(shared.text, /VOLUNTEERED PAY FACTS/);
      const uncached = request.system.filter(block => !block.cache_control).map(block => block.text).join("\n");
      assert.match(uncached, /VOLUNTEERED PAY FACTS.*"grade":"E-5"/);
      if (chatMode === "law_center") assert.match(uncached, /Law Center|LAW CENTER/);
    }
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    app.locals.retrievalClient = originalClient;
    await new Promise(resolve => server.close(resolve));
  }
});
