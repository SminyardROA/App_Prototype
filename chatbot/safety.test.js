import test from "node:test";
import assert from "node:assert/strict";
import {
  CRISIS_MESSAGE,
  CRISIS_OTHERS_MESSAGE,
  INFORMATIONAL_FOOTER,
  REDACTION_NOTICE,
  detectCrisis,
  isHarmToOthers,
  redactPII,
} from "./safety.js";

test("classifies the requested crisis and informational examples", () => {
  assert.equal(detectCrisis("I don't want to be here anymore"), "high");
  assert.equal(detectCrisis("i want to kms"), "high");
  assert.equal(detectCrisis("I'm going to hurt my supervisor"), "high");
  assert.equal(detectCrisis("What suicide prevention resources does the Army Reserve offer?"), "informational");
  assert.equal(detectCrisis("When is my rifle qualification at the range?"), "none");
  assert.equal(detectCrisis("Are you a real person?"), "none");
});

test("returns crisis messages with the requested priority and contact details", () => {
  assert.match(CRISIS_MESSAGE, /^You're not alone/);
  assert.match(CRISIS_MESSAGE, /VETERANS CRISIS LINE/);
  assert.match(CRISIS_MESSAGE, /Call 988, then press 1/);
  assert.match(CRISIS_MESSAGE, /Text 838255/);
  assert.match(CRISIS_MESSAGE, /https:\/\/www\.veteranscrisisline\.net/);
  assert.match(CRISIS_MESSAGE, /https:\/\/988lifeline\.org/);
  assert.match(CRISIS_MESSAGE, /call 911/);
  assert.match(CRISIS_OTHERS_MESSAGE, /^If anyone is in immediate danger, call 911\./);
  assert.match(CRISIS_OTHERS_MESSAGE, /VETERANS CRISIS LINE/);
  assert.match(INFORMATIONAL_FOOTER, /call 988 and press 1, text 838255/);
  assert.equal(isHarmToOthers("I'm going to hurt my supervisor"), true);
  assert.equal(isHarmToOthers("I want to hurt myself"), false);
});

test("recognizes direct and indirect first-person self-harm risk", () => {
  for (const message of [
    "I want to die",
    "I would be better off dead",
    "There is no reason to live",
    "I want to end my life",
    "I might hurt myself tonight",
    "I am thinking about suicide",
    "I'm giving away all my possessions",
    "I'm saying goodbye to everyone",
    "I keep thinking about suicde",
    "I feel like a burden",
  ]) {
    assert.equal(detectCrisis(message), "high", message);
  }
});

test("treats drill and training injuries as injury questions, not self-harm", () => {
  for (const message of [
    "I hurt myself at annual training two weeks ago, injured knee. What do I do and could this lead to a disability claim?",
    "At drill I hurt myself and sprained my ankle. How do I report the injury?",
    "I hurt myself while lifting equipment at training; my back is injured.",
  ]) {
    assert.equal(detectCrisis(message), "none", message);
  }
  for (const message of [
    "I hurt myself at drill and now I want to die.",
    "I hurt myself on purpose at annual training and injured my knee.",
    "I hurt myself at drill and might hurt myself again tonight.",
    "I hurt myself.",
  ]) {
    assert.equal(detectCrisis(message), "high", message);
  }
});

test("recognizes intent to harm others but not military or quoted informational language", () => {
  for (const message of [
    "I'm going to kill him",
    "I want to hurt someone",
    "I plan to shoot my supervisor",
    "I'm planning to shoot",
    "I will stab them",
  ]) {
    assert.equal(detectCrisis(message), "high", message);
    assert.equal(isHarmToOthers(message), true, message);
  }

  for (const message of [
    "When is my rifle qualification at the range?",
    "Explain how a kill switch works.",
    "What is the unit's casualty reporting process?",
    "What suicide prevention training is available?",
    "Can you explain Army suicide prevention statistics?",
    "My friend says he wants to kill himself; how can I get him help?",
  ]) {
    assert.notEqual(detectCrisis(message), "high", message);
  }
  assert.equal(detectCrisis("I'm going to hurt myself, not my supervisor."), "high");
  assert.equal(isHarmToOthers("I'm going to hurt myself, not my supervisor."), false);
});

test("redacts requested personal information and provides a notice string", () => {
  const cases = [
    ["My SSN is 123-45-6789.", "My SSN is [REDACTED]."],
    ["SSN: 123 45 6789", "SSN: [REDACTED]"],
    ["SSN 123456789", "SSN [REDACTED]"],
    ["My DoD ID is 1234567890.", "My DoD ID is [REDACTED]."],
    ["DOB: 04/23/1984", "DOB: [REDACTED]"],
    ["I was born on May 2, 1984.", "I was born on [REDACTED]."],
    ["My birthday is 2 May 1984.", "My birthday is [REDACTED]."],
    ["I live at 42 Oak Street.", "I live at [REDACTED]."],
    ["Address: 123 Main St Apt 4B", "Address: [REDACTED]"],
    ["Call me at (212) 555-0134.", "Call me at [REDACTED]."],
    ["Email me at member@example.com.", "Email me at [REDACTED]."],
  ];

  for (const [input, expected] of cases) {
    assert.equal(redactPII(input), expected, input);
  }
  assert.match(REDACTION_NOTICE, /removed it before processing/);
});

test("leaves common ROA policy, pay, year, dollar, and form references intact", () => {
  const message = "Explain 10 U.S.C. 12301(d), my E-5 pay, $2,026, the 2026 rules, and DD-214.";
  assert.equal(redactPII(message), message);
  assert.equal(redactPII(""), "");
  assert.equal(redactPII(null), null);
});