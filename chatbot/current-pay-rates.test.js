import test from "node:test";
import assert from "node:assert/strict";
import { app } from "./server.js";
import {
  currentBasAnswer,
  currentIdtTravelCapAnswer,
  hasCurrentYearRateEvidence,
  isCurrentBasRateQuestion,
  isCurrentIdtTravelCapQuestion,
  isCurrentPayRateQuestion,
  verifiedBas,
} from "./current-pay-rates.js";

test("current BAS amounts are tied to the official source and a specific calendar year", () => {
  assert.equal(verifiedBas.year, 2026);
  assert.match(verifiedBas.source, /^https:\/\/militarypay\.defense\.gov\//);
  assert.match(currentBasAnswer(2026).text, /\$328\.48.*\$476\.95/);
  const future = currentBasAnswer(2027);
  assert.doesNotMatch(future.text, /\$328\.48|\$476\.95|\$320\.78|\$465\.77/);
  assert.match(future.text, /can't verify the 2027 BAS rates/);
  assert.deepEqual(future.sources, []);
});

test("BAS rate questions use the verified calendar year without overwriting historical requests", () => {
  assert.equal(isCurrentBasRateQuestion("What is the 2026 BAS rate?", 2026), true);
  assert.equal(isCurrentBasRateQuestion("How much is BAS per month?", 2026), true);
  assert.equal(isCurrentBasRateQuestion("What is the 2025 BAS rate?", 2026), false);
  assert.equal(isCurrentBasRateQuestion("Am I eligible for BAS?", 2026), false);
});

test("other current pay rates need same-chunk official-year evidence", () => {
  assert.equal(isCurrentPayRateQuestion("What is the 2026 BAH rate?", 2026), true);
  assert.equal(isCurrentPayRateQuestion("How much drill pay will I get?", 2026), true);
  assert.equal(isCurrentPayRateQuestion("What was the 2025 drill pay rate?", 2026), false);
  assert.equal(isCurrentPayRateQuestion("What is the cap on IDT travel reimbursement?", 2026), false);
  const docs = [
    { url: "https://comptroller.defense.gov/fmr.pdf", text: "2026 BAS is $465.77" },
    { url: "https://www.dfas.mil/pay", text: "2025 BAS is $465.77" },
    { url: "https://www.dfas.mil/pay", text: "2026 basic pay schedule" },
  ];
  assert.equal(hasCurrentYearRateEvidence(docs, 2026), false);
  assert.equal(hasCurrentYearRateEvidence([
    ...docs, { url: "https://www.dfas.mil/pay", text: "2026 E-5 basic pay $3,342.90" },
  ], 2026), true);
});

test("IDT travel cap is per round trip, not monthly, and expires without a verified new year", () => {
  assert.equal(isCurrentIdtTravelCapQuestion("Is IDT travel reimbursement limited to $750 a month?", 2026), true);
  assert.equal(isCurrentIdtTravelCapQuestion("Am I eligible for IDT travel reimbursement?", 2026), false);
  assert.equal(isCurrentIdtTravelCapQuestion("What was the 2025 IDT travel cap?", 2026), false);
  assert.match(currentIdtTravelCapAnswer(2026).text, /\$750 per round trip\*\*, not per month/);
  assert.doesNotMatch(currentIdtTravelCapAnswer(2027).text, /\$750/);
});

test("the BAS chat reply does not ask the model or search index for old rates", async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What is the 2026 BAS rate?", chatMode: "pay" }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const done = events.find(event => event.type === "done");
    assert.ok(done);
    assert.match(done.finalText, /\$328\.48.*\$476\.95/);
    assert.doesNotMatch(done.finalText, /\$320\.78|\$465\.77/);
    assert.ok(done.sources.includes(verifiedBas.source));
    assert.equal(done.retrieval, undefined);
  } finally {
    server.close();
  }
});

test("the chat corrects an IDT travel monthly-cap misconception using DoD guidance", async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Is IDT travel reimbursement limited to $750 a month?" }),
    });
    const done = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === "done");
    assert.match(done.finalText, /per round trip\*\*, not per month/);
    assert.match(done.sources[0], /media\.defense\.gov\/2026/);
    assert.equal(done.retrieval, undefined);
  } finally {
    server.close();
  }
});

test("a 2025-only rate source cannot produce a 2026 rate answer", async () => {
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid",
    embed: async () => [0.1],
    pinecone: null,
    fetch: async (_url, options) => {
      const { filter } = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        matches: filter?.type ? [] : [{
          id: "old-rate",
          score: 0.9,
          metadata: {
            title: "2025 DFAS drill pay",
            url: "https://www.dfas.mil/pay",
            text: "2025 drill pay for an E-5 is $100 per period.",
          },
        }],
      }) };
    },
  };
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What is the 2026 drill pay rate for an E-5?", chatMode: "pay" }),
    });
    assert.equal(response.status, 200);
    const done = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === "done");
    assert.match(done.finalText, /How many cumulative years of service/);
    assert.doesNotMatch(done.finalText, /\$100/);
  } finally {
    delete app.locals.retrievalClient;
    server.close();
  }
});