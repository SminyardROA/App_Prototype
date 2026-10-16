import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { app } from "./server.js";
import {
  compensationAmount, vaCompensationTurn, vaCompensationSnapshot as snapshot,
  CCK_2027_RATES_URL, cck2027RateReference,
} from "./va-compensation.js";
import { parseVaCompensation } from "./scrape-va-compensation.js";

const today = new Date("2026-10-16T12:00:00Z");
const turn = (message, history = [], now = today) => vaCompensationTurn(message, history, now);

test("official cells cover 10–100%, all 12 dependent categories and three additions", () => {
  assert.equal(snapshot.rateYear, 2026);
  assert.equal(snapshot.effectiveDate, "2025-12-01");
  assert.equal(Object.keys(snapshot.basic).length, 12);
  assert.equal(Object.keys(snapshot.additions).length, 3);
  assert.equal(compensationAmount({ rating: 10, spouse: true, under18: 3 }).total, 18042);
  assert.equal(compensationAmount({ rating: 20, parents: 2 }).total, 35666);
  assert.equal(compensationAmount({ rating: 30, spouse: true }).total, 61747);
  assert.equal(compensationAmount({ rating: 100 }).total, 393858);
  assert.equal(compensationAmount({ rating: 100, spouse: true, parents: 2, under18: 1 }).total, 467147);
  for (const row of [...Object.values(snapshot.basic), ...Object.values(snapshot.additions)]) {
    assert.equal(Object.keys(row.amounts).length, 8);
    assert.ok(Object.values(row.amounts).every(Number.isSafeInteger));
  }
});

test("integer-cent arithmetic reproduces VA's spouse + three children + A&A example", () => {
  const result = compensationAmount({ rating: 70, spouse: true, under18: 3, aid: true });
  assert.equal(result.total, 236745);
  assert.equal(result.base, 207445);
  assert.equal(result.extras.length, 2);
  assert.equal(compensationAmount({ rating: 70, spouse: true, under18: 1, school: 1 }).total, 232045);
  assert.equal(compensationAmount({ rating: 70, school: 1 }), null);
  assert.equal(compensationAmount({ rating: 55 }), null);
});

test("asks only missing facts and accepts a bare number for combined rating", () => {
  const first = turn("How much VA disability pay could I receive?");
  assert.match(first.text, /combined disability rating/);
  const history = [{ role: "user", content: "How much VA disability pay could I receive?" },
    { role: "assistant", content: first.text }];
  const second = turn("70", history);
  assert.match(second.text, /spouse, dependent parents, or dependent children/);
  assert.doesNotMatch(second.text, /\$1,808/);
  history.push({ role: "user", content: "70" }, { role: "assistant", content: second.text });
  const third = turn("No dependents", history);
  assert.match(third.text, /\$1,808\.45 per month/);
  assert.match(third.text, /2026/);
  assert.match(third.text, /December 1, 2025/);
});

test("answers volunteered arrangements with explicit assumptions rather than hidden dependent guesses", () => {
  assert.match(turn("What is 2026 VA disability pay at 30% with a spouse, no children and no dependent parents?").text, /\$617\.47 per month/);
  const assumed = turn("What is VA disability pay at 70% with my wife and two children under 18?");
  assert.match(assumed.text, /\$2,150\.45 per month/);
  assert.match(assumed.text, /assumes no others/);
  const aa = turn("What is my VA disability pay at 70% with my spouse and three children under 18? My spouse receives Aid and Attendance.");
  assert.match(aa.text, /\$2,367\.45 per month/);
  assert.match(aa.text, /2 × \$76\.00/);
  assert.match(aa.text, /\$141\.00/);
  const low = turn("How much is VA disability pay at 20% with my spouse and three children?");
  assert.match(low.text, /\$356\.66 per month/);
  assert.match(low.text, /same published rate with or without dependents/);
});

test("holds 2027, never projects a COLA, and stops current use after the snapshot's annual window", () => {
  const future = turn("What are 2027 VA disability compensation rates at 100% with no dependents?");
  assert.match(future.text, /don't have a verified official \*\*2027 VA disability rate table/);
  assert.ok(future.text.includes(CCK_2027_RATES_URL));
  assert.doesNotMatch(future.text, /\$4,080|\$3,938|3\.6%/);
  const stale = turn("What is current VA disability pay at 100% with no dependents?", [], new Date("2026-12-01"));
  assert.match(stale.text, /can't label it the current rate/);
  assert.doesNotMatch(stale.text, /\$3,938/);
  const historical = turn("What was 2026 VA disability pay at 100% with no dependents?", [], new Date("2027-02-01"));
  assert.match(historical.text, /\$3,938\.58/);
});

test("2027 disability-rate replies include CCK only before January 1, 2027 New York time", () => {
  for (const question of [
    "What are the 2027 VA disability rates?",
    "What are the 2027 disability rates?",
    "How much are 2027 VA disability payments with a spouse and children?",
    "What are 2027 VA disability SMC rates?",
  ]) {
    const before = turn(question, [], new Date("2027-01-01T04:59:59Z"));
    assert.ok(before.text.includes(CCK_2027_RATES_URL), question);
    assert.ok(before.sources.includes(CCK_2027_RATES_URL));
    assert.match(before.text, /law-firm reference, not an official VA rate table/);
    assert.doesNotMatch(before.text, /\$4,080|3\.6%/);
    const after = turn(question, [], new Date("2027-01-01T05:00:00Z"));
    assert.ok(!after?.text.includes(CCK_2027_RATES_URL), question);
  }
  assert.equal(cck2027RateReference([2026], today), null);
  assert.equal(cck2027RateReference([2027], new Date("2027-01-01T05:00:00Z")), null);
  assert.doesNotMatch(turn("What is 2026 VA disability pay at 70% with no dependents?").text, /cck-law/);
  assert.equal(turn("What are 2027 SSDI disability rates?"), null);
});

test("does not calculate a new rate from conflicting or separate individual percentages", () => {
  assert.match(turn("What is VA disability pay if I have a 30% and a 50% rating?").text, /one combined rating/);
  assert.match(turn("What is VA disability pay for 55%?").text, /one combined rating/);
  assert.match(turn("What is VA disability pay for 0%?").text, /one combined rating/);
});

test("keeps children age categories distinct and supports all-rating no-dependents display", () => {
  const unknownAges = turn("What is VA disability pay at 70% with two kids?");
  assert.match(unknownAges.text, /how many of those children are/);
  const schoolOnly = turn("How much VA disability pay at 70% with one child aged 20 in college?");
  assert.match(schoolOnly.text, /shouldn't guess a base amount/);
  const table = turn("Show full VA disability pay chart with no dependents");
  assert.match(table.text, /10%: \*\*\$180\.42/);
  assert.match(table.text, /100%: \*\*\$3,938\.58/);
  assert.equal((table.text.match(/%: /g) || []).length, 10);
});

test("does not reuse assistant examples or someone else's facts, and leaves unrelated or complex questions to RAG", () => {
  const history = [
    { role: "user", content: "My buddy has 100% VA disability with no dependents. What is his pay?" },
    { role: "assistant", content: "For this VA compensation lookup at 100%, example amounts are available." },
  ];
  assert.match(turn("What is my own VA disability payment?", history).text, /combined disability rating/);
  const unrelated = [
    { role: "user", content: "I left military service in 2020 and receive 70% military retired pay." },
    { role: "assistant", content: "Which benefit would you like to discuss?" },
  ];
  const fresh = turn("How much VA disability pay could I receive?", unrelated);
  assert.match(fresh.text, /combined disability rating/);
  assert.doesNotMatch(fresh.text, /not a verified 2020|at 70%/);
  for (const message of ["What is BAH?", "How do I file a VA disability claim?",
    "How much is SSDI for disability?", "What is my VA disability back pay?",
    "What are VA SMC disability pay rates?", "How much is VA disability pay after an offset?"]) {
    assert.equal(turn(message), null, message);
  }
});

function fixtureHtml() {
  const span = value => `<span>${value}</span>`;
  const row = cells => `<va-table-row>${cells.map(span).join("")}</va-table-row>`;
  const table = (title, headers, rows) => `<va-table table-title="${title}">${[headers, ...rows].map(row).join("")}</va-table>`;
  let html = "Review 2026 Veterans disability compensation rates. Effective December 1, 2025.";
  const dollars = c => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
  html += table("", ["Disability rating", "Monthly payment"], [["10%", "180.42"], ["20%", "356.66"]]);
  for (const child of [false, true]) for (const ratings of [[30,40,50,60], [70,80,90,100]]) {
    const headers = ["Dependent status", ...ratings.map(r => `${r}% disability rating`)];
    html += table("Basic monthly rates", headers, Object.values(snapshot.basic)
      .filter(r => r.includesOneChild === child).map(r => [r.label, ...ratings.map(p => dollars(r.amounts[p]))]));
    html += table("Added amounts", headers, Object.values(snapshot.additions)
      .filter(r => child || r === snapshot.additions.spouseAidAttendance)
      .map(r => [r.label, ...ratings.map(p => dollars(r.amounts[p]))]));
  }
  return html;
}

test("scraper preserves every source-labelled amount and rejects missing tables, malformed cells or wrong dates", () => {
  const html = fixtureHtml();
  const parsed = parseVaCompensation(html, "2026-10-16T00:00:00Z");
  assert.deepEqual(parsed.smallRatings, snapshot.smallRatings);
  for (const [key, row] of Object.entries(snapshot.basic)) assert.deepEqual(parsed.basic[key].amounts, row.amounts);
  for (const [key, row] of Object.entries(snapshot.additions)) assert.deepEqual(parsed.additions[key].amounts, row.amounts);
  assert.throws(() => parseVaCompensation(html.replace("Review 2026", "Review 2027"), "now"));
  assert.throws(() => parseVaCompensation(html.replace("180.42", "180"), "now"));
  assert.throws(() => parseVaCompensation(html.replace(/<va-table\b[\s\S]*?<\/va-table>/, ""), "now"));
});

test("chat endpoint answers with official rates without a model or Pinecone call", async () => {
  const oldClient = app.locals.retrievalClient;
  const oldStream = Anthropic.Messages.prototype.stream;
  app.locals.retrievalClient = { indexHost: "fixture.invalid",
    embed: () => assert.fail("rate lookup must not embed"), fetch: () => assert.fail("must not query") };
  Anthropic.Messages.prototype.stream = () => assert.fail("must not ask the model for an amount");
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What is 2026 VA disability pay at 70% with no dependents?" }),
    });
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    assert.match(events.at(-1).finalText, /\$1,808\.45/);
    assert.deepEqual(events.at(-1).sources, [snapshot.sourceUrl]);
  } finally {
    app.locals.retrievalClient = oldClient;
    Anthropic.Messages.prototype.stream = oldStream;
    await new Promise(resolve => server.close(resolve));
  }
});
