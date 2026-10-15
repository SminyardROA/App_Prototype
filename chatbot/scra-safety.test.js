import test from "node:test";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
installFixtureVaReviewer();
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { finalizeScraAnswer, isScraQuestion, SCRA_LEASE_URL, SCRA_SERVICE_URL, SCRA_INTEREST_URL } from "./scra-safety.js";

const question = "My Guard activation affects my car loan interest and apartment lease. What SCRA rules apply?";

test("flags the loan-and-lease question for buffered legal review", () => {
  assert.equal(isScraQuestion(question), true);
  assert.equal(isScraQuestion("How does my LES show drill pay?"), false);
});

test("wrong lease citation is never delivered as an answer", () => {
  const draft = "Under 50 U.S.C. § 3956 you can terminate the residential lease.";
  const result = finalizeScraAnswer(draft, question);
  assert.ok(!result.includes("3956"));
  assert.ok(result.includes("§ 3955"));
  assert.ok(result.includes(SCRA_LEASE_URL));
});

test("rejects blanket Title 32 exclusion and points to covered service definition", () => {
  for (const draft of [
    "Title 32 orders generally do not apply under the SCRA.",
    "Title 32 orders generally do NOT qualify for SCRA protections unless they meet a limited exception.",
    "Title 32 National Guard duty generally does **not** qualify for SCRA lease termination rights, with one limited exception.",
  ]) {
    const result = finalizeScraAnswer(draft, question);
    assert.ok(!result.includes("generally do not"));
    assert.match(result, /qualifying Title 32 § 502\(f\) National Guard duty can be covered/);
    assert.ok(result.includes(SCRA_SERVICE_URL));
  }
});

test("does not rewrite unrelated or already-correct answers", () => {
  const valid = "Under 50 U.S.C. § 3955, a qualifying servicemember may terminate a lease. Some Title 32 duty can qualify.";
  assert.equal(finalizeScraAnswer(valid, question), valid);
  assert.equal(finalizeScraAnswer("50 U.S.C. § 3956", "What is my drill pay?"), "50 U.S.C. § 3956");
});

test("Guard lease and pre-service loan answers cannot publish false citations or categorical exclusions", () => {
  for (const question of [
    "Guard Title 32 § 502(f) emergency orders: may I terminate my apartment lease?",
    "National Guard routine Title 32 training orders: can I terminate my apartment lease?",
    "Guard Title 32 § 502(f) emergency orders: does my pre-service car loan get the SCRA interest cap?",
    "National Guard routine Title 32 training orders: does my pre-service car loan get the SCRA interest cap?",
  ]) {
    for (const draft of [
      "The SCRA lease termination provision is 50 U.S.C. § 3956.",
      "Title 32 generally does not qualify for SCRA protection.",
      "Title 32 service is not covered by the SCRA.",
      "Title 32 service is ineligible for SCRA.",
      "Title 32 Guard duty is excluded from SCRA.",
      "SCRA only applies to Title 10 service.",
      "Routine 14-day federally funded Title 32 orders qualify because federal funding alone is enough.",
    ]) {
      const result = finalizeScraAnswer(draft, question);
      assert.doesNotMatch(result, /(?:§|U\.S\.C\.)\s*3956/);
      assert.match(result, /§ 3955/);
      assert.match(result, /§ 3937/);
      assert.match(result, /§ 3911/);
      assert.ok(result.includes(SCRA_LEASE_URL) && result.includes(SCRA_INTEREST_URL) && result.includes(SCRA_SERVICE_URL));
      assert.match(result, /more than 30 consecutive days/);
      assert.match(result, /President-declared national emergency/);
      assert.match(result, /Federal funding alone is not sufficient/);
    }
  }
});

test("accurate limits on routine funding alone remain intact", () => {
  const q = "Do routine 14-day federally funded Title 32 Guard training orders qualify for SCRA?";
  const accurate = "Federal funding alone is not sufficient. Qualifying Title 32 § 502(f) duty must meet the other conditions in 50 U.S.C. § 3911.";
  assert.equal(finalizeScraAnswer(accurate, q), accurate);
});

const leaseArticle = {
  title: "SCRA lease termination",
  url: "https://roa.org/wp-content/uploads/2025/12/23033-LR.pdf",
  text: "The SCRA permits termination of a residential lease entered before military service. A residential lease entered during military service may be terminated after receipt of qualifying PCS or deployment orders.",
};
const unrelatedArticle = {
  title: "SCRA finances",
  url: "https://roa.org/wp-content/uploads/2025/12/other-LR.pdf",
  text: "The SCRA limits interest on debts incurred before military service.",
};
const leaseQuestion = "I got Guard Title 32 mob orders. Can I cancel my apartment lease?";

test("Law Center-only rejects a pre-service-only model draft and cites only article-supported paths", () => {
  const result = finalizeScraAnswer(
    "You must have signed the lease before entering military service to terminate it under the SCRA.",
    leaseQuestion, { lawCenterOnly: true, sourceDocuments: [unrelatedArticle, leaseArticle] }
  );
  assert.match(result, /before military service may be covered/);
  assert.match(result, /during service may also be covered following qualifying PCS or deployment orders/);
  assert.match(result, /authority, duration, purpose/);
  assert.ok(result.includes(leaseArticle.url));
  assert.ok(!result.includes(unrelatedArticle.url));
  assert.doesNotMatch(result, /uscode\.house\.gov|must have signed/);
});

test("Law Center-only does not cite an article for a lease path its text does not support", () => {
  const beforeOnly = { ...leaseArticle, text: "The SCRA permits termination of a residential lease entered before military service." };
  const result = finalizeScraAnswer(
    "A lease entered during service can be terminated after PCS orders.",
    leaseQuestion, { lawCenterOnly: true, sourceDocuments: [beforeOnly, unrelatedArticle] }
  );
  assert.doesNotMatch(result, /during service may also be covered/);
  assert.match(result, /before military service may be covered/);
  assert.ok(result.includes(beforeOnly.url));
  const noSupport = finalizeScraAnswer("You can terminate your lease under SCRA.", leaseQuestion,
    { lawCenterOnly: true, sourceDocuments: [unrelatedArticle] });
  assert.match(noSupport, /articles do not establish the lease rule/);
  assert.match(noSupport, /Full ReserveConnect Navigator/);
  assert.doesNotMatch(noSupport, /other-LR\.pdf|uscode\.house\.gov/);
});

test("Full Navigator corrects exclusive timing claims with both statutory paths", () => {
  for (const draft of [
    "To terminate your lease, you must sign it before entering military service.",
    "Only leases signed prior to military service qualify for SCRA termination.",
    "A lease signed during military service cannot be terminated under SCRA.",
  ]) {
    const result = finalizeScraAnswer(draft, leaseQuestion);
    assert.match(result, /entered before military service is one possible path/);
    assert.match(result, /entered during service followed by qualifying PCS or deployment orders is another/);
    assert.ok(result.includes(SCRA_LEASE_URL) && result.includes(SCRA_SERVICE_URL));
    assert.match(result, /authority, duration, purpose/);
  }
});

test("neither mode asserts Title 32 eligibility from orders alone", () => {
  const draft = "Your Title 32 orders qualify you to terminate your apartment lease under the SCRA.";
  for (const options of [{}, { lawCenterOnly: true, sourceDocuments: [leaseArticle] }]) {
    const result = finalizeScraAnswer(draft, leaseQuestion, options);
    assert.doesNotMatch(result, /orders qualify you|you can terminate/);
    assert.match(result, /orders alone/);
    assert.match(result, /authority, duration, purpose/);
  }
  const careful = `A lease signed during service may be covered after qualifying PCS or deployment orders; whether your Title 32 duty qualifies depends on the authority and duration. See [the Law Center article](${leaseArticle.url}).`;
  assert.equal(finalizeScraAnswer(careful, leaseQuestion,
    { lawCenterOnly: true, sourceDocuments: [leaseArticle] }), careful);
});

test("a non-Guard order alone does not prove an individual can terminate a lease", () => {
  const result = finalizeScraAnswer("Your deployment orders mean you can terminate your apartment lease.",
    "I received deployment orders. Can I cancel my apartment lease?");
  assert.doesNotMatch(result, /you can terminate/);
  assert.match(result, /Neither path establishes your eligibility from orders alone/);
});

test("ordinary terminate wording never passes a pre-service-only rule in either mode", () => {
  const q = "Can I terminate my lease during military service?";
  const draft = "You must have signed the lease before entering duty to terminate it.";
  for (const options of [{}, { lawCenterOnly: true, sourceDocuments: [] }]) {
    const result = finalizeScraAnswer(draft, q, options);
    assert.notEqual(result, draft);
    assert.doesNotMatch(result, /must have signed/);
    assert.match(result, /When did you enter service and sign the lease/);
    if (options.lawCenterOnly) assert.doesNotMatch(result, /uscode\.house\.gov/);
    else assert.match(result, /during service followed by qualifying PCS or deployment orders/);
  }
});

test("notice requirements do not establish qualifying Title 32 orders in either mode", () => {
  for (const draft of [
    "Your Title 32 orders permit you to terminate your lease if you provide written notice.",
    "Your Title 32 orders let you terminate your lease if you provide written notice.",
    "Your Title 32 orders give you the right to terminate your lease if you send notice.",
  ]) {
    for (const options of [{}, { lawCenterOnly: true, sourceDocuments: [] }]) {
      const result = finalizeScraAnswer(draft, leaseQuestion, options);
      assert.notEqual(result, draft);
      assert.doesNotMatch(result, /orders (?:permit|let|give) you/);
      assert.match(result, /authority, duration, purpose/);
      if (options.lawCenterOnly) assert.doesNotMatch(result, /uscode\.house\.gov|Law Center article\]\(/);
    }
  }
  const conditional = "You may terminate your lease if your service meets the qualifying orders requirements and the lease timing qualifies.";
  assert.equal(finalizeScraAnswer(conditional, leaseQuestion), conditional);
});

test("a lease signed after entering service is not automatically excluded", () => {
  const draft = "Because you signed the lease after entering service, you cannot terminate it under SCRA.";
  for (const options of [{}, { lawCenterOnly: true, sourceDocuments: [] }]) {
    const result = finalizeScraAnswer(draft, "Can I terminate my lease during military service?", options);
    assert.notEqual(result, draft);
    assert.doesNotMatch(result, /cannot terminate/);
    assert.match(result, /When did you enter service and sign the lease/);
    if (options.lawCenterOnly) assert.doesNotMatch(result, /uscode\.house\.gov/);
    else assert.match(result, /during service followed by qualifying PCS or deployment orders/);
  }
});

test("natural mobilization wording receives the same lease check", () => {
  assert.equal(isScraQuestion("I got mob orders. Can I cancel my rental agreement?"), true);
  const result = finalizeScraAnswer("You must sign your rental agreement before military service.",
    "I got mob orders. Can I cancel my rental agreement?");
  assert.match(result, /entered during service/);
});

test("chat endpoint sends only corrected lease answers and article-supported citations in both modes", async () => {
  const { app } = await import("./server.js");
  const originalStream = Anthropic.Messages.prototype.stream;
  let draft = "You must have signed the lease before entering military service to cancel it under SCRA.";
  let article = leaseArticle;
  const leaseArticleWithoutTiming = {
    ...unrelatedArticle,
    title: "SCRA residential lease termination",
    text: "The SCRA includes residential lease termination protections for some service members on military orders.",
  };
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid",
    embed: async () => [0.1],
    fetch: async (_url, options) => ({
      ok: true,
      json: async () => ({
        matches: JSON.parse(options.body).filter ? [{
          id: "article", score: 0.95, metadata: article,
        }] : [{
          id: "general", score: 0.8,
          metadata: { url: "https://example.org/other", title: "Unrelated source", text: "Military pay guidance." },
        }],
      }),
    }),
  };
  Anthropic.Messages.prototype.stream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta",
        text: draft } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    },
  });
  const server = app.listen(0);
  try {
    for (const scenario of [
      { text: draft, question: leaseQuestion, source: leaseArticle },
      { text: "Your Title 32 orders let you terminate your lease if you provide written notice.", question: leaseQuestion, source: leaseArticleWithoutTiming },
      { text: "Your Title 32 orders give you the right to terminate your lease if you send notice.", question: leaseQuestion, source: leaseArticleWithoutTiming },
      { text: "Because you signed the lease after entering service, you cannot terminate it under SCRA.",
        question: "Can I terminate my lease during military service?", source: leaseArticleWithoutTiming },
    ]) for (const chatMode of ["law_center", "general"]) {
      draft = scenario.text;
      article = scenario.source;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: scenario.question, chatMode }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)));
      const done = events.at(-1);
      assert.equal(done.type, "done");
      assert.ok(!events.map(event => event.text || "").join(" ").includes(draft));
      assert.notEqual(done.finalText, draft);
      if (chatMode === "law_center") {
        if (article === leaseArticle) {
          assert.match(done.finalText, /authority, duration, purpose/);
          assert.ok(done.sources.includes(leaseArticle.url));
          assert.match(done.finalText, /entered during service/);
        } else {
          assert.deepEqual(done.sources, []);
          assert.match(done.finalText, /couldn't find a matching article/);
        }
        assert.doesNotMatch(done.finalText, /uscode\.house\.gov|example\.org\/other/);
      } else {
        assert.match(done.finalText, /authority, duration, purpose/);
        assert.ok(done.sources.includes(SCRA_LEASE_URL));
        assert.match(done.finalText, /qualifying PCS or deployment orders/);
      }
    }
  } finally {
    Anthropic.Messages.prototype.stream = originalStream;
    delete app.locals.retrievalClient;
    await new Promise(resolve => server.close(resolve));
  }
});