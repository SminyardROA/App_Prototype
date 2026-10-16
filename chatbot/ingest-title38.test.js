import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatute, statuteChunks, buildRecords, ingestSection } from "./ingest-title38.js";

const fixture = `<h1>38 U.S. Code § 101 - Definitions</h1><text><div class="section">
For the purposes of this title—
<div><a name="2"></a>(2) The term “veteran” means qualifying service and discharge.</div>
<div><a name="21"></a>(21) Active duty means full-time duty, other than active duty for training.</div>
<div><a name="22"></a>(22) Active duty for training means full-time duty by Reserves for training.</div>
<div><a name="23"></a>(23) Inactive duty training means duty other than full-time duty.</div>
<div><a name="24"></a>(24) Active service includes qualifying disease or injury during training.</div>
<div class="sourceCredit">Historical credit, not operative language.</div></div></text>
<notes>Editorial notes must not enter the statute.</notes>`;

test("extracts statutory body only and preserves numbered definitions", () => {
  const parsed = parseStatute(fixture, "101");
  assert.equal(parsed.units.length, 5);
  assert.match(parsed.units[1].text, /other than active duty for training/);
  assert.doesNotMatch(parsed.text, /Historical credit|Editorial notes/);
  const combined = statuteChunks(parsed, "101").at(-1);
  assert.match(combined.text, /\(21\).*other than active duty for training/);
  assert.match(combined.text, /\(24\).*disease or injury/);
});

test("fails closed on wrong sections, missing bodies and truncated definitions", () => {
  assert.throws(() => parseStatute(fixture, "1110"));
  assert.throws(() => parseStatute("<h1>38 U.S. Code § 101 - Definitions</h1>", "101"));
  assert.throws(() => parseStatute(fixture.replace('<a name="24"></a>', ""), "101"));
  assert.throws(() => parseStatute(fixture.replace("other than active duty for training", "including training"), "101"));
});

test("keeps lettered subsections and their exceptions together", () => {
  const html = `<h1>38 U.S. Code § 5303A - Minimum service</h1><text>
  <a name="a"></a>(a) Definitions and introductory terms for purposes of this section.
  <a name="b"></a>(b) Minimum service requirement.<a name="b_1"></a>(1) General rule.
  <a name="b_3"></a>(3) Exceptions to the minimum service requirement remain with the rule.</text>`;
  const parsed = parseStatute(html, "5303A");
  assert.equal(parsed.units.length, 2);
  assert.match(parsed.units[1].text, /Exceptions/);
});

test("metadata records true provenance without inventing an effective date", () => {
  const records = buildRecords(parseStatute(fixture, "101"), "101", "2026-10-16T00:00:00Z");
  assert.equal(records[0].id, "usc38-101-statute-chunk-1");
  assert.match(records[0].metadata.url, /law\.cornell\.edu/);
  assert.match(records[0].metadata.currency, /not-independently-verified/);
  assert.equal(records[0].metadata.documentDate, undefined);
});

test("rerunning skips identical records without embedding or upsert", async () => {
  const records = buildRecords(parseStatute(fixture, "101"), "101", "now");
  const index = {
    listPaginated: async () => ({ vectors: records.map(r => ({ id: r.id })) }),
    fetch: async () => ({ records: Object.fromEntries(records.map(r => [r.id, r])) }),
    upsert: async () => assert.fail("must not upsert"),
  };
  assert.deepEqual(await ingestSection(index, records, () => assert.fail("must not embed")), {
    added: 0, skipped: records.length,
  });
});

test("changed snapshots are refused without deleting or overwriting records", async () => {
  const records = buildRecords(parseStatute(fixture, "101"), "101", "now");
  const index = {
    listPaginated: async () => ({ vectors: [{ id: records[0].id }] }),
    fetch: async () => ({ records: { [records[0].id]: { metadata: { sourceTextSha256: "old" } } } }),
    upsert: async () => assert.fail("must not overwrite"),
  };
  await assert.rejects(ingestSection(index, records, () => assert.fail("must not embed")), /snapshot differs/);
});

test("validates embedding dimensions before writing", async () => {
  const records = buildRecords(parseStatute(fixture, "101"), "101", "now");
  const index = {
    listPaginated: async () => ({ vectors: [] }),
    fetch: async () => ({ records: {} }),
    upsert: async () => assert.fail("must not write"),
  };
  await assert.rejects(ingestSection(index, records, async texts => texts.map(() => [1])), /Invalid Voyage/);
});
