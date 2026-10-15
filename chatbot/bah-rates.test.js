import test from "node:test";
import assert from "node:assert/strict";
import { app } from "./server.js";
import { bahRateTurn, BAH_LOOKUP_URL, sanitizeBahLookupState } from "./bah-rates.js";
import { officialAllowanceAnswer } from "./official-allowances.js";

const today = new Date("2026-09-27T12:00:00Z");

test("BAH lists actual housing areas within a state, then asks for the missing dependency status", () => {
  const listed = bahRateTurn("What is the 2026 BAH rate for E-5 in Texas?", null, today);
  assert.match(listed.text, /ABILENE\/DYESS AFB, TX \(TX270\)/);
  assert.match(listed.text, /AUSTIN, TX \(TX272\)/);
  assert.doesNotMatch(listed.text, /\$1,872/);
  const selected = bahRateTurn("TX270", listed.state, today);
  assert.match(selected.text, /Do you have dependents/);
  assert.doesNotMatch(selected.text, /\$1,872/);
  const withDeps = bahRateTurn("Yes", selected.state, today);
  assert.match(withDeps.text, /\$1,872\/month/);
  assert.match(withDeps.text, /May 16–December 31, 2026/);
  assert.match(withDeps.sources[0], /media\.defense\.gov/);
  const withoutDeps = bahRateTurn("No", selected.state, today);
  assert.match(withoutDeps.text, /\$1,545\/month/);
  assert.doesNotMatch(withoutDeps.text, /\$1,872/);
});

test("BAH uses areas, not ZIP codes or BAH-RC, and never rolls its snapshot to 2027", () => {
  assert.match(bahRateTurn("What is my 2026 BAH rate for 79605?", null, today).text, /not ZIP codes/);
  assert.match(bahRateTurn("What is the 2027 BAH rate for Texas?", null, new Date("2027-02-01")).text, /only have a verified 2026 locality BAH snapshot/);
  const first = bahRateTurn("What was the BAH rate in Texas in January 2026 for E-5 with dependents?", null, today);
  const old = bahRateTurn("TX270", first.state, today);
  assert.match(old.text, /can't use it for an earlier date/);
  assert.equal(old.state, null);
  assert.equal(sanitizeBahLookupState({ state: "TX", area: "TX999", grade: "E05", dependents: true }).area, null);
  assert.match(BAH_LOOKUP_URL, /travel\.dod\.mil/);
  const direct = bahRateTurn("How much is 2026 BAH in Abilene for E5 without dependents?", null, today);
  assert.match(direct.text, /\$1,545\/month/);
  assert.match(direct.text, /not a determination that locality BAH applies/);
  assert.match(bahRateTurn("What is the BAH-RC 2026 rate for an E-5?", null, today).text, /non-locality/);
  assert.match(bahRateTurn("What BAH rate do I get for 14-day drill orders?", null, today).text, /does not generally apply to IDT\/drill/);
  assert.match(bahRateTurn("What is BAH for 14-day AT in TX?", null, today).text, /contingency operation/);
});

test("official allowance guidance distinguishes reimbursement, fixed FSA, and means-tested BNA", () => {
  const adoption = officialAllowanceAnswer("How much is adoption reimbursement?", 2026);
  assert.match(adoption.text, /180 days of continuous active duty/);
  assert.match(adoption.text, /within two years/);
  assert.doesNotMatch(adoption.text, /\$2,000/);
  assert.match(officialAllowanceAnswer("What is FSA per month?", 2026).text, /\$300 per month/);
  assert.match(officialAllowanceAnswer("What is BNA?", 2026).text, /does \*\*not\*\* state a blanket 180-day/);
  assert.doesNotMatch(officialAllowanceAnswer("What is BNA?", 2026).text, /\$\d/);
});

test("chat BAH follow-up uses supplied state and with/without dependent sheet", async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  let state;
  try {
    for (const [message, expected] of [
      ["What is 2026 BAH for E-5 in Texas?", /ABILENE\/DYESS/],
      ["1", /Do you have dependents/],
      ["No", /\$1,545\/month/],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, chatMode: "pay", conversationState: state }),
      });
      assert.equal(response.status, 200);
      const done = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6))).find(event => event.type === "done");
      assert.match(done.finalText, expected);
      assert.equal(done.retrieval, undefined);
      state = done.conversationState;
    }
    assert.equal(state.bahLookup, null);
  } finally {
    server.close();
  }
});