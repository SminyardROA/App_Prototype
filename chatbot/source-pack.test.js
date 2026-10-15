import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { app, embedQuery, getKnowledgeBaseContext } from "./server.js";
import { sourcePackAuthentication, sourcePackHandler, sourcePackMatches, publicationDateNumber } from "./source-pack.js";
import { queryKnowledgeIndex } from "./knowledge-search.js";

const TEST_TOKEN = "dummy-source-pack-test-token";
const record = (id, text, score = 0.8, metadata = {}) => ({
  id, score, metadata: { text, title: "Policy", url: "https://example.org/policy.pdf", ...metadata },
});

function retrievalClient({ matches = () => [], namespaces = { "": {} }, embed } = {}) {
  const calls = [];
  return {
    indexHost: "example.test",
    calls,
    embed: embed || (async (query, { signal }) => {
      calls.push({ kind: "embed", query, signal });
      return [1, 2, 3];
    }),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ kind: "fetch", url, body, signal: options.signal });
      if (url.endsWith("/describe_index_stats")) return Response.json({ namespaces });
      return Response.json({ matches: matches(body) });
    },
  };
}

async function fixture(t, { token = TEST_TOKEN, client = retrievalClient(), timeoutMs } = {}) {
  const logs = [];
  const serverApp = express();
  serverApp.post("/api/source-pack", sourcePackAuthentication(() => token));
  serverApp.use(express.json({ limit: "64kb" }));
  serverApp.use((error, req, res, next) => {
    if (error.type === "entity.parse.failed" || error.type === "entity.too.large") {
      return res.status(error.status || 400).json({ error: "Invalid request body" });
    }
    next(error);
  });
  serverApp.post("/api/source-pack", sourcePackHandler({
    getClient: () => client, timeoutMs, logCount: count => logs.push(count),
  }));
  const server = serverApp.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = `http://127.0.0.1:${server.address().port}/api/source-pack`;
  const request = (body = { queries: ["reserve retirement"] }, header = TEST_TOKEN) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(header === null ? {} : { "x-source-pack-token": header }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request, logs, client, url };
}

test("source pack is disabled without configuration and auth precedes parsing", async t => {
  const disabled = await fixture(t, { token: "" });
  assert.equal((await disabled.request("{")).status, 404);
  assert.deepEqual(disabled.logs, []);
  assert.deepEqual(disabled.client.calls, []);
  const enabled = await fixture(t);
  for (const token of [null, "", "wrong", "dummy-source-pack-test-tokeN"]) {
    assert.equal((await enabled.request("{", token)).status, 401);
  }
  assert.deepEqual(enabled.logs, []);
  assert.deepEqual(enabled.client.calls, []);
  assert.equal((await enabled.request("{")).status, 400);
});

test("source pack validates query counts, types, lengths and topK before retrieval", async t => {
  const { request, client } = await fixture(t);
  for (const body of [
    {}, null, { queries: [] }, { queries: "text" }, { queries: [" "] },
    { queries: [null] }, { queries: [123] }, { queries: ["a".repeat(2001)] },
    { queries: Array(41).fill("query") },
    ...[0, 21, 1.2, "8", null].map(topK => ({ queries: ["query"], topK })),
  ]) assert.equal((await request(body)).status, 400, JSON.stringify(body).slice(0, 100));
  assert.deepEqual(client.calls, []);
});

test("source pack merges all namespaces, preserves metadata and text, deduplicates and orders", async t => {
  const longText = "Full passage ".repeat(400);
  const extra = { date: "2026-09-01", chunkIndex: 7, tags: ["reserve"], nestedEvidence: "keep" };
  const client = retrievalClient({
    namespaces: { "": {}, "course-library": {}, "other-reader": {} },
    matches: body => body.namespace === ""
      ? [record("duplicate-default", longText, 0.7, extra), record("a", "Second passage", 0.5)]
      : body.namespace === "course-library"
        ? [record("duplicate-best", longText, 0.9, extra), record("b", "Third passage", 0.6)]
        : [record("c", "Fourth passage", 0.8), { id: "no-passage", score: 1, metadata: { title: "Missing text" } }],
  });
  const { request, logs } = await fixture(t, { client });
  const response = await request({ queries: ["first", "second"], topK: 3 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { results, namespaces_searched, searched_namespaces } = await response.json();
  assert.deepEqual(results.map(result => result.query), ["first", "second"]);
  assert.equal(namespaces_searched, 3);
  assert.deepEqual(searched_namespaces, ["", "course-library", "other-reader"]);
  for (const result of results) {
    assert.deepEqual(result.matches.map(match => match.score), [0.9, 0.8, 0.6]);
    const first = result.matches[0];
    assert.equal(first.text, longText);
    assert.equal(first.chunk_id, "duplicate-best");
    assert.equal(first.namespace, "course-library");
    assert.equal(first.source_title, "Policy");
    assert.equal(first.source_url_or_file, "https://example.org/policy.pdf");
    assert.equal(first.date, extra.date);
    assert.deepEqual(first.metadata, record("", longText, 0, extra).metadata);
  }
  assert.deepEqual(logs, [2]);
  assert.equal(client.calls.filter(call => call.kind === "embed").length, 2);
  const searches = client.calls.filter(call => call.url?.endsWith("/query"));
  assert.equal(searches.length, 6);
  assert.ok(searches.every(call => call.body.topK === 3 && call.body.includeMetadata &&
    !call.body.includeValues && !call.body.filter && call.signal instanceof AbortSignal));
});

test("default topK is eight; max topK is twenty; forty queries preserve order", async t => {
  const client = retrievalClient({
    matches: () => Array.from({ length: 20 }, (_, i) => record(`${i}`, `passage ${i}`, 1 - i / 100)),
  });
  const { request } = await fixture(t, { client });
  assert.equal((await (await request()).json()).results[0].matches.length, 8);
  const queries = Array.from({ length: 40 }, (_, i) => `query ${i}`);
  const result = await (await request({ queries, topK: 20 })).json();
  assert.deepEqual(result.results.map(item => item.query), queries);
  assert.ok(result.results.every(item => item.matches.length === 20));
  assert.equal(client.calls.filter(call => call.kind === "embed").length, 41);
});

test("metadata aliases and optional dates do not discard original fields", () => {
  const metadata = { content: "Original text", source_title: "Guide", file_path: "guide.pdf", publication_date: "2025", source: "origin" };
  const [match] = sourcePackMatches([{ id: "id", score: 0.5, namespace: "", metadata }], 8);
  assert.equal(match.source_title, "Guide");
  assert.equal(match.source_url_or_file, "guide.pdf");
  assert.equal(match.date, "2025");
  assert.deepEqual(match.metadata, metadata);
  assert.equal(sourcePackMatches([record("x", "passage")], 1)[0].date, null);
  const indexed = sourcePackMatches([record("y", "other", 1, { ingestionDate: "2026-08-27" })], 1)[0];
  assert.equal(indexed.date, "2026-08-27");
  assert.equal(indexed.metadata.ingestionDate, "2026-08-27");
});

test("date conversion rejects impossible dates and converts valid boundaries to YYYYMMDD", () => {
  assert.equal(publicationDateNumber("2024-02-29"), 20240229);
  assert.equal(publicationDateNumber("2023-01-01"), 20230101);
  for (const invalid of ["2023-02-29", "2024-04-31", "0000-01-01", "2024-00-15",
    "2024-13-01", "2024-01-00", "2024-1-1", "2024-01-01T00:00:00Z", 20240101, null]) {
    assert.throws(() => publicationDateNumber(invalid), /valid dates in YYYY-MM-DD format/);
  }
});

test("explicit namespaces search only inventoried selections, including default when requested", async t => {
  const client = retrievalClient({
    namespaces: { "": {}, research: {}, "roa-nationalsecurity": {} },
    matches: body => [record(body.namespace || "default", `passage from ${body.namespace || "default"}`)],
  });
  const { request, logs } = await fixture(t, { client });
  const selected = await request({ queries: ["analysis"], namespaces: ["roa-nationalsecurity"] });
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), {
    results: [{ query: "analysis", matches: [{
      score: 0.8, text: "passage from roa-nationalsecurity", source_title: "Policy",
      source_url_or_file: "https://example.org/policy.pdf", date: null,
      namespace: "roa-nationalsecurity", chunk_id: "roa-nationalsecurity",
      metadata: record("x", "passage from roa-nationalsecurity").metadata,
    }] }],
    namespaces_searched: 1,
    searched_namespaces: ["roa-nationalsecurity"],
  });
  assert.deepEqual(client.calls.filter(call => call.url?.endsWith("/query")).map(call => call.body.namespace),
    ["roa-nationalsecurity"]);
  const withDefault = await (await request({
    queries: ["two"], namespaces: ["", "research", "research"], topK: 2,
  })).json();
  assert.equal(withDefault.namespaces_searched, 2);
  assert.deepEqual(withDefault.searched_namespaces, ["", "research"]);
  assert.deepEqual(withDefault.results[0].matches.map(match => match.namespace), ["", "research"]);
  const searchesBefore = client.calls.filter(call => call.url?.endsWith("/query")).length;
  const embedsBefore = client.calls.filter(call => call.kind === "embed").length;
  const missing = await request({ queries: ["missing"], namespaces: ["research", "not-yet-present"] });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /namespaces do not exist in the index inventory/);
  assert.equal(client.calls.filter(call => call.url?.endsWith("/query")).length, searchesBefore);
  assert.equal(client.calls.filter(call => call.kind === "embed").length, embedsBefore);
  for (const invalid of [[], "research", [null], [12]]) {
    assert.equal((await request({ queries: ["x"], namespaces: invalid })).status, 400);
  }
  assert.deepEqual(logs, [1, 1, 1]);
});

test("an explicitly selected default namespace must be present in inventory", async t => {
  const client = retrievalClient({ namespaces: { research: {} } });
  const { request } = await fixture(t, { client });
  assert.equal((await request({ queries: ["x"], namespaces: [""] })).status, 400);
  const defaultRequest = await request({ queries: ["x"] });
  assert.equal(defaultRequest.status, 200);
  assert.deepEqual((await defaultRequest.json()).searched_namespaces, ["", "research"]);
});

test("document type and inclusive publication range are applied as a numeric Pinecone filter", async t => {
  const records = [
    record("early", "too old", 0.95, { doc_type: "report", publication_date: "2022-12-31", publication_date_num: 20221231 }),
    record("first", "first day", 0.9, { doc_type: "report", publication_date: "2023-01-01", publication_date_num: 20230101, publication_date_precision: "day", date: "old date", ingestionDate: "2026-08-27" }),
    record("last", "last day", 0.8, { doc_type: "report", publication_date: "2025-12-31", publication_date_num: 20251231, publication_date_precision: "month" }),
    record("later", "too new", 0.9, { doc_type: "report", publication_date_num: 20260101 }),
    record("law", "wrong type", 0.9, { doc_type: "law", publication_date_num: 20240101 }),
    record("untyped", "missing type", 0.9, { publication_date_num: 20240101 }),
    record("undated", "missing numeric date", 0.9, { doc_type: "report", publication_date: "2024-01-01" }),
  ];
  const client = retrievalClient({
    namespaces: { "roa-nationalsecurity": {} },
    matches: body => records.filter(({ metadata }) =>
      (!body.filter?.doc_type || metadata.doc_type === body.filter.doc_type.$eq) &&
      (!body.filter?.publication_date_num || typeof metadata.publication_date_num === "number" &&
        metadata.publication_date_num >= (body.filter.publication_date_num.$gte ?? -Infinity) &&
        metadata.publication_date_num <= (body.filter.publication_date_num.$lte ?? Infinity))),
  });
  const { request } = await fixture(t, { client });
  const response = await request({
    queries: ["staff report"],
    namespaces: ["roa-nationalsecurity"],
    filter: { doc_type: "report", publication_date: { from: "2023-01-01", to: "2025-12-31" } },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.namespaces_searched, 1);
  assert.deepEqual(result.results[0].matches.map(match => match.chunk_id), ["first", "last"]);
  const first = result.results[0].matches[0];
  assert.equal(first.date, "2023-01-01");
  assert.equal(first.publication_date, "2023-01-01");
  assert.equal(first.publication_date_precision, "day");
  assert.equal(first.doc_type, "report");
  assert.equal(first.metadata.date, "old date");
  assert.equal(first.metadata.ingestionDate, "2026-08-27");
  assert.deepEqual(client.calls.find(call => call.url?.endsWith("/query")).body.filter, {
    doc_type: { $eq: "report" },
    publication_date_num: { $gte: 20230101, $lte: 20251231 },
  });
  assert.equal(result.results[0].matches[1].publication_date_precision, "month");
  const noResults = await (await request({ queries: ["x"], namespaces: ["roa-nationalsecurity"],
    filter: { doc_type: "data", publication_date: { from: "2023-01-01" } } })).json();
  assert.deepEqual(noResults.results[0].matches, []);
  assert.equal(noResults.namespaces_searched, 1);
});

test("malformed filters return 400 without embedding or Pinecone inventory calls", async t => {
  const { request, client } = await fixture(t);
  for (const filter of [
    null, "report", [], { doc_type: "unknown" }, { doc_type: ["report"] },
    { publication_date: {} }, { publication_date: null },
    { publication_date: { from: "2023-02-29" } },
    { publication_date: { from: "2025-12-31", to: "2023-01-01" } },
    { publication_date: { to: "yesterday" } },
    { publication_date: { from: "2023-01-01", extra: "x" } },
    { unexpected: { $ne: "report" } },
  ]) {
    const response = await request({ queries: ["x"], filter });
    assert.equal(response.status, 400, JSON.stringify(filter));
    assert.match((await response.json()).error, /filter|publication date/i);
  }
  assert.deepEqual(client.calls, []);
});

test("member chat retrieval never queries or fetches outside the default namespace", async () => {
  const calls = [];
  const client = {
    indexHost: "fixture.invalid",
    embed: async () => [0.1],
    fetch: async (url, options) => {
      assert.equal(url, "https://fixture.invalid/query", "chat must not enumerate namespaces");
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.ok(body.namespace === undefined || body.namespace === "",
        `member chat tried non-default namespace: ${body.namespace}`);
      return Response.json({ matches: [] });
    },
    pinecone: { index: () => ({
      fetch: async (ids, options) => {
        assert.equal(options?.namespace, undefined);
        return { records: {} };
      },
      namespace: () => { throw new Error("member chat selected a non-default namespace"); },
    }) },
  };
  for (const [mode, question] of [
    ["general", "How do I retire?"],
    ["general", "What are my USERRA reemployment and SCRA lease rights?"],
    ["law_center", "How does SCRA apply to my lease?"],
    ["pay", "How is BAH paid?"],
    ["benefits", "What are my benefits?"],
    ["transition", "What does DD Form 214-1 mean when separating?"],
    ["va", "How do I apply for VA benefits?"],
  ]) {
    const context = await getKnowledgeBaseContext(question, { chatMode: mode, retrievalClient: client });
    assert.notEqual(context.status, "unavailable", `${mode}: member chat retrieval failed`);
  }
  assert.ok(calls.length >= 7);
  assert.ok(calls.every(body => body.namespace === undefined || body.namespace === ""));
});

test("raw search transport is shared with chat and preserves the default query settings", async () => {
  let captured;
  await queryKnowledgeIndex({ indexHost: "example.test", fetch: async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return Response.json({ matches: [] });
  } }, { vector: [1], topK: 12 });
  assert.deepEqual(captured, {
    url: "https://example.test/query",
    body: { vector: [1], includeMetadata: true, includeValues: false, topK: 12, namespace: "" },
  });
});

test("the existing embedQuery uses the live model and query input settings for source packs", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured;
  const controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body), signal: options.signal };
    return Response.json({ data: [{ embedding: [1, 2] }] });
  };
  assert.deepEqual(await embedQuery("query", { signal: controller.signal }), [1, 2]);
  assert.deepEqual(captured, {
    url: "https://api.voyageai.com/v1/embeddings",
    body: { model: "voyage-law-2", input: ["query"], input_type: "query" },
    signal: controller.signal,
  });
});

test("unavailable retrieval, provider failures and malformed namespaces fail clearly without leaks", async t => {
  const unavailable = await fixture(t, { client: null });
  assert.equal((await unavailable.request()).status, 503);
  for (const [client, expected] of [
    [{ ...retrievalClient(), embed: async () => { throw new Error("sensitive query TOKEN"); } }, "Voyage query embedding failed"],
    [{ ...retrievalClient(), fetch: async () => Response.json({ error: "TOKEN sensitive query" }, { status: 403 }) }, "Pinecone describe_index_stats failed (HTTP 403)"],
    [{ ...retrievalClient(), fetch: async () => Response.json({ namespaces: null }) }, "Pinecone namespace inventory was invalid"],
    [{ ...retrievalClient(), fetch: async url => url.endsWith("/describe_index_stats")
      ? Response.json({ namespaces: {} }) : Response.json({ bad: "TOKEN" }) }, "Pinecone search returned invalid matches"],
  ]) {
    const endpoint = await fixture(t, { client });
    const response = await endpoint.request();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: expected });
    assert.deepEqual(endpoint.logs, [1]);
  }
});

test("short timeout aborts outbound work even when an embedding promise never resolves", async t => {
  let signal;
  const client = retrievalClient({ embed: (query, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const { request } = await fixture(t, { client, timeoutMs: 25 });
  const response = await request();
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(client.calls.filter(call => call.url?.endsWith("/query")).length, 0);
});

test("source packs bound simultaneous embeddings to four", async t => {
  let active = 0;
  let maximum = 0;
  const client = retrievalClient({ embed: async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return [1];
  } });
  const { request } = await fixture(t, { client });
  assert.equal((await request({ queries: Array(12).fill("query") })).status, 200);
  assert.equal(maximum, 4);
});

test("actual server source-pack route stays disabled by default and CORS remains unchanged", async t => {
  if (process.env.SOURCE_PACK_TOKEN) return t.skip("Operator has enabled the route");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/source-pack`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(response.status, 404);
  const crossOrigin = await fetch(url, { method: "POST", headers: { Origin: "https://example.org" } });
  assert.equal(crossOrigin.status, 403);
  const preflight = await fetch(url, { method: "OPTIONS" });
  assert.equal(preflight.status, 404);
});
