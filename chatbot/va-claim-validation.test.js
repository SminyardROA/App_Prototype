import test from "node:test";
import assert from "node:assert/strict";
import {
  answerUnits, validateVaAnswer,
  VA_VALIDATION_FAILURE, VA_VALIDATION_UNAVAILABLE, CLAIM_REVIEW_PROMPT,
} from "./va-claim-validation.js";

const url = "https://www.va.gov/evidence";
const doc = { url, text: "ADT covers disease or injury. IDT covers injury and expressly listed exceptions." };
const good = `ADT covers disease or injury [source](${url}).`;
const result = units => ({
  stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 30 },
  content: [{ type: "text", text: JSON.stringify({ units }) }],
});
const supported = id => ({ id, status: "supported", evidence: [{ url, quote: "ADT covers disease or injury." }] });
const run = (answer, create, options = {}) => validateVaAnswer({
  answer, question: "VA eligibility?", documents: [doc], create, model: "fixture", ...options,
});

test("every sentence and closing is a review unit; citation URLs remain intact", () => {
  const units = answerUnits(`${good} You qualify for every VA benefit.\n\nRelated reading: [title](${url}).`);
  assert.equal(units.length, 3);
  assert.ok(units[0].text.includes(url));
});

test("a paragraph-end citation covers its own sentences only, with per-claim proof still required", async () => {
  const answer = `ADT covers disease or injury. IDT covers injury and expressly listed exceptions [source](${url}).`;
  const checked = await run(answer, async () => result([
    supported(0), { id: 1, status: "supported", evidence: [{
      url, quote: "IDT covers injury and expressly listed exceptions.",
    }] },
  ]));
  assert.equal(checked.status, "verified");
  assert.ok(answerUnits(answer).every(unit => unit.citationUrls.includes(url)));
  assert.deepEqual(answerUnits(`Uncited claim.\n\n[source](${url})`)[0].citationUrls, []);
  const anchored = await run(`ADT covers disease or injury [source](${url}#page=2).`,
    async () => result([supported(0)]));
  assert.equal(anchored.status, "verified");
});

test("semantic claim identification runs without VA words or retrieved evidence", async () => {
  let calls = 0;
  const answer = "A Certificate of Eligibility guarantees approval for a home loan.";
  const checked = await run(answer, async params => {
    calls++;
    const request = JSON.parse(params.messages[0].content);
    assert.equal(request.units[0].text, answer);
    assert.deepEqual(request.passages, []);
    return result([{ id: 0, status: "unsupported" }]);
  }, { documents: [], requireEvidence: false });
  assert.equal(calls, 1);
  assert.equal(checked.text, VA_VALIDATION_FAILURE);
  const unrelated = await run("Check with your employer.", async () =>
    result([{ id: 0, status: "out_of_scope" }]), { documents: [], requireEvidence: false });
  assert.equal(unrelated.text, "Check with your employer.");
  const uncertain = await run(answer, async () =>
    result([{ id: 0, status: "uncertain" }]), { documents: [], requireEvidence: false });
  assert.equal(uncertain.text, VA_VALIDATION_UNAVAILABLE);
});

test("a supported sentence cannot validate a neighboring unsupported claim; narrowed text is rechecked", async () => {
  const requests = [];
  const checked = await run(`${good} You qualify for every VA benefit.`, async (params, options) => {
    requests.push(JSON.parse(params.messages[0].content));
    assert.equal(options.maxRetries, 0);
    assert.equal(params.system, CLAIM_REVIEW_PROMPT);
    assert.equal(params.cache_control, undefined);
    return requests.length === 1
      ? result([supported(0), { id: 1, status: "unsupported" }])
      : result([supported(0), { id: 1, status: "nonclaim" }]);
  });
  assert.equal(checked.status, "narrowed");
  assert.doesNotMatch(checked.text, /You qualify/);
  assert.equal(requests.length, 2);
  assert.match(requests[1].units[1].text, /couldn't verify/);
  assert.deepEqual(requests[0].passages, [{ id: "p0", ...doc }]);
  assert.equal(checked.metrics.inputTokens, 200);
  assert.equal(checked.metrics.outputTokens, 60);
});

test("narrowing that changes meaning is rejected rather than displayed", async () => {
  let calls = 0;
  const checked = await run(`${good} Unsupported caveat.`, async () => {
    calls++;
    return calls === 1 ? result([supported(0), { id: 1, status: "unsupported" }])
      : result([{ id: 0, status: "unsupported" }, { id: 1, status: "nonclaim" }]);
  });
  assert.equal(checked.text, VA_VALIDATION_FAILURE);
  assert.equal(calls, 2);
});

test("no sources and unknown citations fail before any paid audit", async () => {
  const create = () => { throw new Error("must not run"); };
  assert.equal((await run(good, create, { documents: [] })).status, "no_evidence");
  assert.equal((await run(`${good} See https://www.va.gov/unknown`, create)).status, "unknown_citation");
});

test("invalid coverage and truncated output fail closed as unavailable", async () => {
  for (const response of [
    result([]),
    result([supported(0), supported(0)]),
    { ...result([supported(0)]), stop_reason: "max_tokens" },
    { ...result([supported(0)]), content: [{ type: "text", text: "not JSON" }] },
  ]) {
    assert.equal((await run(good, async () => response)).text, VA_VALIDATION_UNAVAILABLE);
  }
});

test("invented, missing, or uncited evidence rejects the claim, not a fictitious provider outage", async () => {
  for (const evidence of [[], null, [null], [{ url, quote: "Invented legal rule." }],
    [{ url: "https://www.va.gov/other", quote: doc.text }]]) {
    const checked = await run(good, async () => result([{ id: 0, status: "supported", evidence }]));
    assert.equal(checked.status, "unsupported");
    assert.equal(checked.text, VA_VALIDATION_FAILURE);
    assert.equal(checked.metrics.calls, 1);
  }
  assert.equal((await run(`Uncited claim.\n\nSee [source](${url}).`,
    async () => result([supported(0), { id: 1, status: "nonclaim" }]))).text, VA_VALIDATION_FAILURE);
});

test("a reviewer cannot borrow a different paragraph's citation; supported material is rechecked", async () => {
  let calls = 0;
  const answer = `${good}\n\nYou qualify for all VA benefits.\n\nCheck Congress.gov.`;
  const checked = await run(answer, async params => {
    calls++;
    const units = JSON.parse(params.messages[0].content).units;
    if (calls === 1) {
      assert.deepEqual(units[1].citationUrls, []);
      return result([supported(0), supported(1), {
        id: 2, status: "nonclaim", evidence: [{ url: "https://www.congress.gov/unretrieved", quote: "" }],
      }]);
    }
    assert.doesNotMatch(units.map(u => u.text).join(" "), /You qualify|unretrieved/);
    return result([supported(0), { id: 1, status: "nonclaim" }, { id: 2, status: "nonclaim" }]);
  });
  assert.equal(checked.status, "narrowed");
  assert.equal(calls, 2);
  assert.match(checked.text, /ADT covers disease or injury/);
  assert.doesNotMatch(checked.text, /You qualify|unretrieved/);
});

test("an invented quote in one unit cannot contaminate otherwise supported material", async () => {
  let calls = 0;
  const checked = await run(`${good} Every veteran gets a free home [source](${url}).`, async () =>
    ++calls === 1 ? result([supported(0), { ...supported(1),
      evidence: [{ url, quote: "Every veteran gets a free home." }] }])
      : result([supported(0), { id: 1, status: "nonclaim" }]));
  assert.equal(checked.status, "narrowed");
  assert.doesNotMatch(checked.text, /free home/);
  assert.equal(calls, 2);
});

test("invalid evidence on the whole narrowed recheck still blocks display", async () => {
  let calls = 0;
  const checked = await run(`${good}\n\nUncited eligibility conclusion.`, async () =>
    ++calls === 1 ? result([supported(0), supported(1)])
      : result([{ ...supported(0), evidence: [{ url, quote: "Not in the source." }] },
        { id: 1, status: "nonclaim" }]));
  assert.equal(checked.status, "unsupported");
  assert.equal(checked.text, VA_VALIDATION_FAILURE);
  assert.equal(calls, 2);
});

test("passage ids resolve only to immutable retrieved text and its declared citation", async () => {
  const checked = await run(good, async params => {
    const request = JSON.parse(params.messages[0].content);
    assert.equal(request.passages[0].id, "p0");
    assert.equal(request.passages[0].text, doc.text);
    return result([{ id: 0, status: "supported", evidence: [{ passageId: "p0" }] }]);
  });
  assert.equal(checked.status, "verified");
  assert.equal(checked.text, good);
  for (const evidence of [
    { passageId: "invented" }, { passageId: 0 },
    { passageId: "p0", quote: "Invented legal rule." },
    { passageId: "p0", url: "https://www.va.gov/other" },
  ]) {
    assert.equal((await run(good, async () =>
      result([{ id: 0, status: "supported", evidence: [evidence] }]))).status, "unsupported");
  }
  const uncited = await run(`Uncited eligibility claim.\n\n[source](${url})`,
    async () => result([{ id: 0, status: "supported", evidence: [{ passageId: "p0" }] },
      { id: 1, status: "nonclaim" }]));
  assert.equal(uncited.status, "unsupported");
});

test("passage-id evidence preserves citations during narrowing and requires a whole-answer recheck", async () => {
  let calls = 0;
  const checked = await run(`ADT covers disease or injury. Unsupported guarantee [source](${url}).`,
    async params => {
      calls++;
      const request = JSON.parse(params.messages[0].content);
      if (calls === 2) assert.ok(request.units[0].text.includes(url));
      return result([{ id: 0, status: "supported", evidence: [{ passageId: "p0" }] },
        { id: 1, status: calls === 1 ? "unsupported" : "nonclaim" }]);
    });
  assert.equal(checked.status, "narrowed");
  assert.equal(calls, 2);
  assert.doesNotMatch(checked.text, /Unsupported guarantee/);
  assert.match(checked.text, /ADT covers disease or injury/);
});

test("timeout aborts the request; provider exceptions never escape or reveal private text", async () => {
  let signal;
  const checked = await run(good, async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 10 });
  assert.equal(signal.aborted, true);
  assert.equal(checked.text, VA_VALIDATION_UNAVAILABLE);
  assert.equal(checked.metrics.calls, 1);
  const failed = await run(good, async () => { throw new Error("private question, medical facts and body"); });
  assert.equal(failed.text, VA_VALIDATION_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(failed), /private question|medical facts/);
});

test("audit contract requires all high-risk distinctions and final-answer scope", () => {
  for (const term of ["EVERY atomic", "server-added", "ADT/AT", "IDT", "Calendar",
    "Honorary", "home-loan", "actual relevant list excerpt", "dated proposal", "outside knowledge",
    "ALL factual VA benefit", "payment amounts", "funding fees", "covered services",
    "application deadlines", "filing procedures", "are NEVER out_of_scope"]) {
    assert.ok(CLAIM_REVIEW_PROMPT.includes(term), term);
  }
});
