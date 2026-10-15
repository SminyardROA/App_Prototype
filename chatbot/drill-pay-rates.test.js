import test from "node:test";
import assert from "node:assert/strict";
import { app } from "./server.js";
import { drillPayTables, drillPayTurn, lookupDrillPay } from "./drill-pay-rates.js";

test("all four official tables have an effective date, source and notes", () => {
  assert.equal(drillPayTables.size, 4);
  for (const table of drillPayTables.values()) {
    assert.equal(table.effectiveDate, "2026-01-01");
    assert.match(table.url, /^https:\/\/www\.dfas\.mil\//);
    assert.ok(table.notes.some(note => /Page updated January/.test(note)));
  }
});

test("lookup uses explicit drill figures and strict over-year boundaries", () => {
  assert.deepEqual([lookupDrillPay("E-5", 6).oneDrillCents, lookupDrillPay("E-5", 6).fourDrillsCents], [13156, 52624]);
  assert.deepEqual([lookupDrillPay("E-5", 6.01).oneDrillCents, lookupDrillPay("E-5", 6.01).fourDrillsCents], [13700, 54800]);
  assert.deepEqual([lookupDrillPay("O-3", 8).oneDrillCents, lookupDrillPay("O-3", 8).fourDrillsCents], [25790, 103160]);
  assert.deepEqual([lookupDrillPay("O-3E", 8.01).oneDrillCents, lookupDrillPay("O-3E", 8.01).fourDrillsCents], [27085, 108340]);
  assert.deepEqual([lookupDrillPay("W-2", 12).oneDrillCents, lookupDrillPay("W-2", 12).fourDrillsCents], [20942, 83768]);
  assert.equal(lookupDrillPay("W-5", 8), null);
  assert.equal(lookupDrillPay("O-3E", 3), null);
  assert.equal(lookupDrillPay("E-1", 30), null); // DFAS snapshot has copied E-9 cells here
});

test("answer cites the matching drill table, not monthly basic pay", () => {
  const answer = drillPayTurn("How much 2026 drill pay for O-3E with over 8 years?", null, new Date("2026-09-01"));
  assert.match(answer.text, /\$270\.85 for 1 drill.*\$1,083\.40 for 4 drills/);
  assert.match(answer.text, /not a universal monthly paycheck/);
  assert.match(answer.text, /not monthly basic pay/);
  assert.match(answer.sources[0], /Drill-Pay-CO_FE/);
  assert.match(drillPayTurn("Drill pay for E-5 with 6 years of service?", null, new Date("2026-09-01")).sources[0], /Drill-Pay_E/);
  assert.match(drillPayTurn("Drill pay for O-3 with 8 years of service?", null, new Date("2026-09-01")).sources[0], /Drill-Pay-CO\//);
  assert.match(drillPayTurn("Drill pay for W-2 with 12 years of service?", null, new Date("2026-09-01")).sources[0], /Drill-Pay_WO/);
});

test("missing grade and years are asked for without quoting another row", () => {
  const first = drillPayTurn("What is 2026 drill pay?", null, new Date("2026-09-01"));
  assert.match(first.text, /What is your pay grade/);
  const second = drillPayTurn("E-5", first.state, new Date("2026-09-01"));
  assert.match(second.text, /How many cumulative years of service/);
  const third = drillPayTurn("6", second.state, new Date("2026-09-01"));
  assert.match(third.text, /\$131\.56 for 1 drill/);
  assert.equal(third.state, null);
  assert.match(drillPayTurn("2026 prior enlisted O-3 drill pay with 8 years?", null, new Date("2026-09-01")).text, /confirm your pay grade as O-3E/);
});

test("former enlisted grade does not displace a clearly current commissioned grade", () => {
  const answer = drillPayTurn("How much 2026 drill pay for former E-5 now O-3 with 8 years of service?", null, new Date("2026-09-01"));
  assert.match(answer.text, /For O-3 with 8 cumulative years/);
  assert.match(answer.text, /\$257\.90 for 1 drill/);
  assert.doesNotMatch(answer.text, /\$137\.00/);
  assert.match(answer.sources[0], /Drill-Pay-CO\//);
});

test("multiple unqualified grade mentions ask for current grade", () => {
  const first = drillPayTurn("What is 2026 drill pay, E-5 or O-3, with 8 years of service?", null, new Date("2026-09-01"));
  assert.match(first.text, /Which is your current pay grade/);
  assert.deepEqual(first.sources, []);
  const second = drillPayTurn("O-3E", first.state, new Date("2026-09-01"));
  assert.match(second.text, /For O-3E with 8 cumulative years/);
  assert.match(second.sources[0], /Drill-Pay-CO_FE/);
});

test("year rollover fails closed unless 2026 was explicitly requested", () => {
  const now = new Date("2027-01-02");
  const future = drillPayTurn("How much drill pay for E-5 with 6 years?", null, now);
  assert.deepEqual(future.sources, []);
  assert.doesNotMatch(future.text, /\$131\.56/);
  assert.match(future.text, /can't verify 2027 drill rates/);
  assert.match(drillPayTurn("How much 2026 drill pay for E-5 with 6 years?", null, now).text, /\$131\.56/);
  assert.deepEqual(drillPayTurn("How much 2027 drill pay for E-5 with 6 years?", null, new Date("2026-09-01")).sources, []);
});

async function chat(message, conversationState) {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, chatMode: "pay", conversationState }),
    });
    assert.equal(response.status, 200);
    return (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === "done");
  } finally {
    server.close();
  }
}

test("chat carries the missing-details state and returns cited 2026 drill amounts", async () => {
  const first = await chat("How much is 2026 drill pay for E-5?");
  assert.match(first.finalText, /How many cumulative years of service/);
  assert.equal(first.conversationState.drillPayLookup.grade, "E-5");
  const second = await chat("6", first.conversationState);
  assert.match(second.finalText, /\$131\.56 for 1 drill.*\$526\.24 for 4 drills/);
  assert.match(second.sources[0], /Drill-Pay_E/);
  assert.equal(second.conversationState.drillPayLookup, null);
  assert.equal(second.retrieval, undefined);
});

test("multi-turn chat asks which grade is current before using former-enlisted rates", async () => {
  const first = await chat("How much 2026 drill pay for former E-5, O-3, with 8 years of service?");
  assert.match(first.finalText, /Which is your current pay grade/);
  assert.deepEqual(first.sources, []);
  const second = await chat("O-3E", first.conversationState);
  assert.match(second.finalText, /For O-3E with 8 cumulative years/);
  assert.match(second.sources[0], /Drill-Pay-CO_FE/);
});