import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { app } from "./server.js";
import { VETERAN_DEFINITION_URL } from "./veteran-definition.js";
import { LIMB_LOSS_TOPIC, limbLossOverview } from "./injury-retrieval.js";
import { vaCfrPlans } from "./va-cfr-retrieval.js";
import { resolveVaCitationMarkers } from "./va-disability.js";

test("numbered citations bind to the real retrieved URLs without AI quote checking", () => {
  const documents = [{ url: "https://www.va.gov/disability/" }];
  const result = resolveVaCitationMarkers("An overview [[SOURCE:1]].", documents);
  assert.equal(result.text, "An overview [Source 1](https://www.va.gov/disability/).");
  assert.equal(result.unresolved, false);
  assert.equal(resolveVaCitationMarkers("[[SOURCE:9]]", documents).unresolved, true);
  assert.equal(resolveVaCitationMarkers("[[SOURCE:0]]", documents).unresolved, true);
});

test("ordinary limb-loss wording reaches amputation, SMC and service-connection research", () => {
  for (const text of [
    "What about limb loss? I have a buddy who lost a limb due to an injury while he was in the Navy.",
    "VA benefits after an amputation", "He lost his leg during service",
  ]) {
    assert.equal(LIMB_LOSS_TOPIC.test(text), true);
    const sections = vaCfrPlans(text).map(p => p.section);
    for (const section of ["4.71a", "3.350", "3.303"]) assert.ok(sections.includes(section), section);
  }
});

test("a broad limb-loss overview uses actual retrieved tables without guessed numbers", () => {
  const docs = [
    { url: "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=4",
      text: "§ 4.71a Schedule of ratings. Amputations. 5120 shoulder disarticulation" },
    { url: "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=3",
      text: "§ 3.303 Principles relating to service connection." },
    { url: "https://www.ecfr.gov/api/versioner/v1/full/2026-08-05/title-38.xml?part=3",
      text: "Special monthly compensation for anatomical loss or loss of use." },
  ];
  const q = "What about limb loss? My buddy lost a limb in the Navy.";
  const text = limbLossOverview(q, docs);
  assert.match(text, /service connection/);
  assert.match(text, /Special Monthly Compensation/);
  assert.doesNotMatch(text, /\d+\s*(?:%|percent)/);
  assert.match(text, /not an automatic award/);
  assert.equal(limbLossOverview(q, []), null);
  assert.equal(limbLossOverview("What rating for amputation?", docs), null);
});

test("chat no longer invokes a second AI reviewer; citation and missing-source boundaries remain", async () => {
  const oldStream = Anthropic.Messages.prototype.stream;
  const oldCreate = Anthropic.Messages.prototype.create;
  const oldClient = app.locals.retrievalClient;
  const url = "https://www.va.gov/disability/eligibility/";
  let noSources = false, reviewerCalls = 0, generationCalls = 0;
  let draft = "The retrieved material discusses amputation-related disability benefits [[SOURCE:1]]. Which limb was lost?";
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid", embed: async () => [1],
    fetch: async (_url, options) => {
      assert.equal(JSON.parse(options.body).namespace, "");
      return { ok: true, json: async () => ({ matches: noSources ? [] : [{
        id: "synthetic", score: 0.99, metadata: { url, title: "Disability evidence",
          text: "VA disability claims for amputation and anatomical loss require relevant evidence." },
      }, {
        id: "definition", score: 0.8, metadata: { url: VETERAN_DEFINITION_URL,
          title: "Who is a Veteran?", text: "Veteran status definitions and benefit eligibility differ by benefit." },
      }] }) };
    },
  };
  Anthropic.Messages.prototype.stream = () => {
    generationCalls++;
    return { async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: draft } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    } };
  };
  Anthropic.Messages.prototype.create = async () => {
    reviewerCalls++;
    throw new Error("An independent reviewer must not be called");
  };
  const server = app.listen(0);
  const send = async message => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    return (await r.text()).split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6))).at(-1);
  };
  try {
    const question = "What about limb loss? I have a buddy who lost a limb due to an injury while he was in the Navy.";
    const answer = await send(question);
    assert.match(answer.finalText, /amputation-related disability benefits/);
    assert.ok(answer.sources.includes(url));
    assert.equal(answer.claimValidation, undefined);
    draft = "Your friend automatically gets a 100 percent disability rating.";
    assert.doesNotMatch((await send(question)).finalText, /automatically gets/);
    draft = "An unsupported rule [source](https://www.va.gov/invented).";
    assert.doesNotMatch((await send(question)).finalText, /unsupported rule|invented/);
    const definition = await send("Am I a veteran and eligible for benefits?");
    assert.match(definition.finalText, /Which benefit|one.*veteran.*definition/i);
    assert.equal(definition.claimValidation, undefined);
    noSources = true;
    const before = generationCalls;
    assert.match((await send(question)).finalText, /supporting|source|material/i);
    assert.equal(generationCalls, before);
    assert.equal(reviewerCalls, 0);
  } finally {
    Anthropic.Messages.prototype.stream = oldStream;
    Anthropic.Messages.prototype.create = oldCreate;
    app.locals.retrievalClient = oldClient;
    await new Promise(resolve => server.close(resolve));
  }
});
