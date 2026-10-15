import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { score } from "./multisource-baseline.js";

const cases = JSON.parse(fs.readFileSync(new URL("./multisource-baseline.json", import.meta.url))).cases;
const guardCases = cases.filter(c => c.id.startsWith("scra-guard-"));

test("four grounded Guard scenarios cover lease and interest with qualifying and routine orders", () => {
  assert.equal(guardCases.length, 4);
  for (const c of guardCases) {
    assert.equal(c.authorities.length, 2);
    assert.ok(c.authorities.some(a => a.urlPattern.includes("3911")));
    assert.ok(c.answerChecks.some(check => check.forbidden && check.pattern.includes("3956")) || c.id.includes("loan"));
    const goodAnswer = c.id.includes("lease")
      ? "SCRA residential lease termination is 50 U.S.C. § 3955. Send written notice and orders."
      : "The pre-service debt interest cap of 6% is in 50 U.S.C. § 3937. Send written notice and orders.";
    const coverage = c.id.includes("routine")
      ? "Title 32 § 502(f) federal funding alone is not sufficient for routine orders; qualifying service requires a President-declared national emergency and more than 30 consecutive days."
      : "Title 32 § 502(f) orders can qualify if authorized for more than 30 consecutive days for a President-declared national emergency.";
    const response = { answer: `${goodAnswer} ${coverage}`, sources: [], retrieval: {} };
    const result = score(c, response);
    assert.equal(result.answerCheckCoverage, result.requiredAnswerChecks, c.id);
    const wrong = score(c, { ...response, answer: `${response.answer} Title 32 generally does not qualify for SCRA. The lease statute is 50 U.S.C. § 3956.` });
    assert.ok(wrong.answerCheckCoverage < wrong.requiredAnswerChecks, c.id);
    const exclusion = score(c, { ...response, answer: "Title 32 service is not covered by the SCRA. " + goodAnswer });
    assert.ok(exclusion.answerCheckCoverage < exclusion.requiredAnswerChecks, c.id);
    const ineligible = score(c, { ...response, answer: "Title 32 service is ineligible for SCRA. " + goodAnswer });
    assert.ok(ineligible.answerCheckCoverage < ineligible.requiredAnswerChecks, c.id);
    if (c.id.includes("routine")) {
      const fundingOnly = score(c, { ...response, answer: `${goodAnswer} Routine 14-day federally funded Title 32 orders qualify because federal funding alone is enough. Title 32 § 502(f) national emergency.` });
      assert.ok(fundingOnly.answerCheckCoverage < fundingOnly.requiredAnswerChecks, c.id);
    }
  }
});