import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getKnowledgeBaseContext, normalizeChatMode, routeForMode } from "./server.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const widgetSource = fs.readFileSync(path.join(testDir, "..", "widget.js"), "utf8");
const testPageSource = fs.readFileSync(path.join(testDir, "testpage.html"), "utf8");

for (const [mode, category] of [
  ["pay", "pay"],
  ["benefits", "benefits"],
  ["transition", "transition"],
  ["va", "va"],
]) {
  test(`${mode} mode selects the ${category} retrieval category`, () => {
    assert.equal(normalizeChatMode(mode), mode);
    assert.equal(routeForMode(mode, "A deliberately unrelated question").key, category);
  });

}

test("invalid chat modes are rejected by validation", () => {
  assert.equal(normalizeChatMode("not-a-mode"), null);
});

test("legacy Law Center requests retain their mode", () => {
  assert.equal(normalizeChatMode(undefined, true), "law_center");
});

test("both clients use full retrieval without Search Mode controls", () => {
  assert.equal(normalizeChatMode(undefined), "general");
  for (const source of [testPageSource, widgetSource]) {
    assert.doesNotMatch(source, /data-(?:chat-)?mode=|Search mode|setSearchMode|chatMode,/i);
  }
  assert.match(testPageSource, /history = \[\];/);
  assert.match(widgetSource, /conversationHistory = \[\];/);
  for (const source of [testPageSource, widgetSource]) {
    assert.match(source, /conversationState = \{\};/);
    assert.match(source, /dd214PathwayState,[\s\S]{0,120}conversationState:/);
    assert.match(source, /conversationState:\s*\{\s*\.\.\.conversationState/);
    assert.match(source, /crisisActive/);
  }
});

// These records deliberately mix four source families in one unfiltered index.
// The mock index scores the actual expanded query, rather than returning a
// mode-specific canned result, so changes to query expansion affect the ranking.
const fixtureRecords = [
  ...[
    ["pay-dfas", "https://www.dfas.mil/militarymembers/payentitlements/", "DFAS drill pay LES", "DFAS drill pay LES"],
    ["pay-fmr", "https://comptroller.defense.gov/portals/45/documents/fmr/volume_07a.pdf", "DoD FMR pay", "DoD Financial Management Regulation pay"],
    ["pay-jtr", "https://www.travel.dod.mil/Policy-Regulations/Joint-Travel-Regulations/", "JTR travel reimbursement", "JTR travel reimbursement"],
    ["benefits-tricare", "https://www.tricare.mil/Plans/Eligibility/NGRMandFamilies", "TRICARE family insurance", "TRICARE family insurance"],
    ["benefits-education", "https://www.militaryonesource.mil/education-employment/", "Education family benefits", "education family benefits"],
    ["benefits-health", "https://www.tricare.mil/Plans/HealthPlans/TRS", "TRICARE healthcare", "TRICARE healthcare insurance"],
    ["transition-tap", "https://www.dodtap.mil/", "TAP civilian career", "TAP civilian career"],
    ["transition-records", "https://www.esd.whs.mil/Directives/issuances/dodi/", "Separation service records", "separation records transition"],
    ["transition-mentor", "https://www.dol.gov/agencies/vets/programs/tap", "Civilian mentor transition", "civilian mentor transition"],
    ["va-claims", "https://www.va.gov/disability/how-to-file-claim/", "VA disability claim", "VA disability claim"],
    ["va-rating", "https://www.va.gov/disability/about-disability-ratings/", "VA rating evidence", "VA rating evidence"],
    ["va-health", "https://www.va.gov/health-care/eligibility/", "Veterans Affairs health care", "Veterans Affairs eligibility"],
  ].map(([id, url, title, signals]) => ({
    id, signals, metadata: {
      url, title, text: `Fixture excerpt: ${title}.`,
      ...(id === "pay-fmr" ? { source: "docs/Volume_07a.pdf" } : {}),
    },
  })),
  { id: "off-topic", signals: "voting election", metadata: {
    url: "https://example.org/voting", title: "Election information", text: "Unrelated resource.",
  } },
];

function fixtureClient() {
  const calls = [];
  return {
    calls,
    indexHost: "fixture.invalid",
    embed: async query => query,
    pinecone: null,
    fetch: async (url, options) => {
      assert.equal(url, "https://fixture.invalid/query");
      const { vector, filter, topK } = JSON.parse(options.body);
      calls.push({ filter, topK, query: vector });
      const words = new Set(vector.toLowerCase().match(/[a-z]+/g));
      const matches = fixtureRecords
        .filter(record => !filter || (
          filter.source?.$eq === "docs/Volume_07a.pdf" && record.id === "pay-fmr"
        ))
        .map(record => ({
          ...record,
          score: Math.min(0.95, 0.45 + 0.1 * record.signals.toLowerCase().split(" ")
            .filter(word => words.has(word)).length),
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, topK);
      return { ok: true, json: async () => ({ matches }) };
    },
  };
}

for (const [mode, question, expectedIds] of [
  ["pay", "How do I check my drill pay on my LES?", ["pay-fmr", "pay-dfas", "pay-jtr"]],
  ["benefits", "What health insurance and education benefits cover my family?", ["benefits-tricare", "benefits-health", "benefits-education"]],
  ["transition", "How can I prepare for a civilian career after service?", ["transition-tap", "transition-records", "transition-mentor"]],
  ["va", "How do I file a VA disability claim with evidence for a rating?", ["va-claims", "va-rating"]],
]) {
  test(`${mode} retrieval prioritizes its source family over unrelated records`, async () => {
    const client = fixtureClient();
    const result = await getKnowledgeBaseContext(question, {
      chatMode: mode,
      forceDd214Pathway: false,
      retrievalClient: client,
    });
    assert.ok(result, `${mode} must retrieve context`);
    assert.equal(result.retrieval.category, mode);
    assert.ok(client.calls.some(call => !call.filter), "the general Pinecone query must run");
    const sources = [...result.context.matchAll(/\[Source \d+: [^\n]+\]/g)].map(match => match[0]);
    assert.ok(sources.length >= 2, "must retrieve multiple sources");
    const family = source => expectedIds.some(id => source.includes(
      fixtureRecords.find(record => record.id === id).metadata.url
    ));
    assert.ok(family(sources[0]), `first source is off-topic: ${sources[0]}`);
    assert.ok(sources.filter(family).length > sources.length / 2,
      `unrelated sources dominate ${mode}: ${sources.join(", ")}`);
    for (const id of expectedIds) {
      const record = fixtureRecords.find(candidate => candidate.id === id);
      assert.ok(result.context.includes(record.metadata.title),
        `${mode} did not retain expected source ${id}`);
    }
  });
}