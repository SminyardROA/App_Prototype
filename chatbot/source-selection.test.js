import test from "node:test";
import assert from "node:assert/strict";
import { selectDiverseMatches, publicSourceUrl, sourceAttribution, visibleAnswerSources, supplementalSourceLinks, getKnowledgeBaseContext } from "./server.js";
import { evaluateDeterministically, loadScenarios } from "./simulated-member-beta.js";

const match = (id, url, score = 1) => ({ id, score, metadata: { url, text: id } });

test("selects distinct canonical documents before duplicate chunks", () => {
  const selected = selectDiverseMatches([
    match("law-1", "https://roa.org/law/article.pdf#page=1"),
    match("law-2", "https://roa.org/law/article.pdf#page=2"),
    match("official", "https://www.justice.gov/scra.pdf"),
    match("other", "https://www.dol.gov/userra"),
  ], 3);
  assert.deepEqual(selected.map(item => item.id), ["law-1", "official", "other"]);
});

test("keeps pinned policy priority while making room for another authority", () => {
  const selected = selectDiverseMatches([
    match("fmr-pinned", "https://comptroller.defense.gov/fmr/volume_07a.pdf"),
    match("law-1", "https://roa.org/law/article.pdf"),
    match("law-2", "https://roa.org/law/article.pdf#page=9"),
    match("jtr", "https://www.travel.dod.mil/jtr.pdf"),
  ], 3);
  assert.deepEqual(selected.map(item => item.id), ["fmr-pinned", "law-1", "jtr"]);
});

test("fills remaining slots when fewer distinct documents exist", () => {
  const selected = selectDiverseMatches([
    match("one", "https://example.test/a"),
    match("two", "https://example.test/a#fragment"),
  ], 3);
  assert.deepEqual(selected.map(item => item.id), ["one", "two"]);
});

test("reserves a slot for a required general or official candidate", () => {
  const law = Array.from({ length: 4 }, (_, i) => match(`law-${i}`, `https://roa.org/law/${i}.pdf`));
  const official = match("official", "https://www.justice.gov/scra.pdf");
  const selected = selectDiverseMatches([...law, official], 4, undefined, [official]);
  assert.ok(selected.some(item => item.id === "official"));
  assert.equal(selected.length, 4);
  assert.deepEqual(selected.map(item => item.id), ["law-0", "law-1", "law-2", "official"]);
});

test("canonicalizes source metadata when URL is unavailable", () => {
  const selected = selectDiverseMatches([
    { id: "a", metadata: { source: "docs/policy.pdf#page=1" } },
    { id: "b", metadata: { source: "docs/policy.pdf#page=2" } },
    { id: "c", metadata: { source: "docs/other.pdf" } },
  ], 2);
  assert.deepEqual(selected.map(item => item.id), ["a", "c"]);
});

test("attributes a two-source IDT answer to FMR pay and public JTR", () => {
  const attribution = sourceAttribution(
    "How should I distinguish my IDT drill pay from travel or lodging reimbursement?",
    [
      { title: "DoD Financial Management Regulation Volume 7A", url: "https://comptroller.defense.gov/portals/45/documents/fmr/volume_07a.pdf", text: "Drill pay is basic pay." },
      { title: "JTR §032303 IDT Travel", url: "./jtr.pdf", text: "IDT travel and lodging allowances." },
    ]
  );
  assert.match(attribution, /volume_07a\.pdf/);
  assert.match(attribution, /Travel-Transportation-Rates\/Per-Diem\/JTR/);
  assert.doesNotMatch(attribution, /\]\(\.\/jtr\.pdf\)/);
});

test("mixed question retrieves two supporting documents even when blended results favor one", async () => {
  const job = { id: "job", score: 0.85, metadata: {
    url: "https://roa.org/law/19100.pdf", title: "USERRA reemployment",
    text: "USERRA protects civilian reemployment after military service.",
  } };
  const lease = { id: "lease", score: 0.82, metadata: {
    url: "https://roa.org/law/14083.pdf", title: "SCRA lease termination",
    text: "Under SCRA a residential lease may be terminated on qualifying military orders.",
  } };
  const filler = Array.from({ length: 14 }, (_, i) => ({
    id: `filler-${i}`, score: 0.9, metadata: {
      url: `https://roa.org/law/unrelated-${i}.pdf`, title: "Other legal issue",
      text: "General legal advice unrelated to either issue.",
    },
  }));
  const calls = [];
  const retrievalClient = {
    indexHost: "mock.test",
    embed: async text => text,
    fetch: async (_url, options) => {
      const { vector } = JSON.parse(options.body);
      calls.push(vector);
      return { ok: true, json: async () => ({
        matches: vector.startsWith("SCRA residential") ? [lease] :
          vector.startsWith("USERRA civilian") ? [job] : filler,
      }) };
    },
  };
  const mixed = await getKnowledgeBaseContext(
    "Under USERRA what are my civilian reemployment rights and under SCRA how do I terminate a residential lease?",
    { retrievalClient },
  );
  assert.deepEqual(mixed.retrieval.retrievedAuthorityFamilies, {
    userraReemployment: [job.metadata.url], scraLease: [lease.metadata.url],
  });
  assert.ok(mixed.sources.includes(job.metadata.url));
  assert.ok(mixed.sources.includes(lease.metadata.url));
  assert.equal(calls.length, 4); // general, Law Center, and two focused searches

  calls.length = 0;
  const single = await getKnowledgeBaseContext(
    "Under USERRA what are my civilian reemployment rights?", { retrievalClient },
  );
  assert.equal(calls.length, 2); // ordinary legal search remains unchanged
  assert.deepEqual(single.retrieval.retrievedAuthorityFamilies, {});
});

test("labeled beta cases require distinct retrieved, visible and claim-cited sources", () => {
  const scenario = loadScenarios().find(item => item.id === "mixed-userra-scra-army");
  const job = "https://roa.org/law/job.pdf";
  const lease = "https://roa.org/law/lease.pdf";
  const answer = `For USERRA reemployment see [job guidance](${job}); for SCRA residential lease termination see [lease guidance](${lease}).`;
  const done = { sources: [job, lease], retrieval: {
    category: "legal", selectedChunks: 2, lawReviewPrioritized: true, lawReviewSourceMatches: 2,
    retrievedAuthorityFamilies: { userraReemployment: [job], scraLease: [lease] },
  } };
  const run = (text, payload) => evaluateDeterministically(scenario, {
    answer: text, done: payload, transcript: [{ answer: text, done: payload, expected: {} }],
  });
  assert.equal(run(answer, done).pass, true);
  assert.equal(run(answer.replace(lease, job), done).pass, false);
  assert.equal(run(answer, { ...done, sources: [job] }).pass, false);
  assert.equal(run(answer, { ...done, retrieval: {
    ...done.retrieval, retrievedAuthorityFamilies: { userraReemployment: [job], scraLease: [job] },
  } }).pass, false);
  assert.equal(run(`USERRA reemployment and SCRA residential lease termination. ${job} ${lease}`, done).pass, false);
});

test("attributes SCRA lease and interest to verified, distinct statutory sections", () => {
  const attribution = sourceAttribution(
    "My Guard activation affects both my SCRA car loan interest and apartment lease.",
    [
      { title: "SCRA lease termination", url: "https://www.justice.gov/servicemembers/scra-guide", text: "Residential lease termination under the SCRA." },
      { title: "SCRA interest rate", url: "https://www.justice.gov/servicemembers/scra-interest", text: "Interest rate protection for qualifying obligations." },
      { title: "Unrelated transition article", url: "https://roa.org/transition", text: "DD Form 214 transition checklist." },
    ],
    "SCRA car loan interest and residential lease termination have different rules."
  );
  assert.match(attribution, /section%3A3955/);
  assert.match(attribution, /section%3A3937/);
  assert.doesNotMatch(attribution, /roa\.org\/transition/);
  assert.doesNotMatch(attribution, /scra-guide|scra-interest/);
});

test("shows at most three sources cited in the final answer, never unused retrieved chunks", () => {
  const documents = Array.from({ length: 7 }, (_, i) => ({
    url: `https://example.org/document-${i}`, text: `Content ${i}`,
  }));
  const answer = [
    "For the first claim see [document 4](https://example.org/document-4).",
    "For the next, [document 1](https://example.org/document-1).",
    "For context [document 3](https://example.org/document-3).",
    "An additional [document 5](https://example.org/document-5) is also cited.",
    "This unrelated [link](https://unrelated.example/other) was not retrieved.",
  ].join(" ");
  assert.deepEqual(visibleAnswerSources(answer, documents), [
    documents[4].url, documents[1].url, documents[3].url,
  ]);
  assert.deepEqual(visibleAnswerSources("The answer does not cite a document.", documents), []);
  assert.deepEqual(visibleAnswerSources(
    "See [lease](https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3955%20edition%3Aprelim%29).",
  ).length, 1);
});

test("does not create attribution for absent or unsupported authorities", () => {
  assert.equal(
    sourceAttribution("What is my drill pay?", [
      { title: "General article", url: "https://roa.org/general", text: "General Reserve information." },
    ]),
    ""
  );
  assert.equal(publicSourceUrl("./jtr.pdf"), "https://www.travel.dod.mil/Travel-Transportation-Rates/Per-Diem/JTR/");
});

test("adds up to three relevant reading links, never unrelated retrieved chunks", () => {
  const docs = Array.from({ length: 4 }, (_, i) => ({
    title: `Drill travel source ${i + 1}`,
    url: `https://official.example/drill-travel-${i + 1}`,
    text: "IDT drill travel reimbursement and lodging eligibility for Reserve members.",
  }));
  docs.push({ title: "Unrelated medical source", url: "https://official.example/medical",
    text: "Medical prescription and pharmacy advice." });
  const links = supplementalSourceLinks("How does IDT drill travel reimbursement work?",
    "IDT drill travel reimbursement depends on the applicable lodging policy.", docs);
  assert.equal((links.match(/\]\(https:\/\//g) || []).length, 3);
  assert.doesNotMatch(links, /medical/);
  assert.equal(supplementalSourceLinks("What is my pay?", "Your pay varies.", docs), "");
  assert.equal(supplementalSourceLinks("How does IDT drill travel reimbursement work?",
    "Travel and lodging depend on the rules.", []), "");
});