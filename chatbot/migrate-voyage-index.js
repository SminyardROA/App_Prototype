/**
 * Non-destructive Pinecone migration. Reads the old index via list/fetch,
 * re-embeds metadata.text with Voyage, and writes to a separate dense index.
 * Restarting resumes after the last fully upserted page.
 */
import { Pinecone } from "@pinecone-database/pinecone";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = "roa-knowledge-base";
const TARGET = "roa-kb-voyage-law2-20260923";
const MODEL = "voyage-law-2";
const PROGRESS = path.join(dir, "voyage-migration-progress.json");
const MANIFEST = path.join(dir, "voyage-migration-manifest.json");
const catalog = JSON.parse(fs.readFileSync(path.join(dir, "lr-articles.json"), "utf8"));
const lawUrls = new Set(catalog.filter(a => a.source === "ROA Service Members Law Center").map(a => a.url.toLowerCase()));
const isLawCenterDocument = url => {
  const value = String(url || "").toLowerCase();
  return lawUrls.has(value) ||
    /^https:\/\/(?:www\.)?roa\.org\/wp-content\/uploads\/.+(?:-lr\.pdf|\/lr\d+[^/]*\.pdf|law-review\.pdf)$/i.test(value);
};

if (!process.env.PINECONE_API_KEY || !process.env.VOYAGE_API_KEY) throw new Error("PINECONE_API_KEY and VOYAGE_API_KEY are required");
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const retry = async (fn, label) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt === 5 || /Limit must be|validation|invalid argument|414 Request-URI Too Large/i.test(error.message) ||
        (error.status && ![429, 500, 502, 503, 504].includes(error.status))) throw error;
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      console.warn(`${label}: retry ${attempt + 1} after ${delay}ms (${error.status || error.message})`);
      await pause(delay);
    }
  }
};
async function embed(texts) {
  return retry(async () => {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: texts, input_type: "document" }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      const error = new Error(`Voyage HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    if (data.data?.length !== texts.length) throw new Error("Voyage embedding count mismatch");
    return data.data.map(item => item.embedding);
  }, "Voyage");
}
function save(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, file);
}
async function main() {
  const sourceInfo = await pc.describeIndex(SOURCE);
  const sample = await embed(["Document: dimensionality probe\n\nReserve Component"]);
  const dimension = sample[0].length;
  if (dimension !== 1024) throw new Error(`Unexpected ${MODEL} dimension ${dimension}; inspect index settings before continuing`);
  let targetInfo;
  try { targetInfo = await pc.describeIndex(TARGET); }
  catch (error) {
    if (error.status !== 404 && error.name !== "PineconeNotFoundError") throw error;
    console.log(`Creating separate index ${TARGET} (${dimension}d cosine, ${JSON.stringify(sourceInfo.spec.serverless)})`);
    await pc.createIndex({
      name: TARGET, dimension, metric: "cosine",
      spec: { serverless: sourceInfo.spec.serverless },
      waitUntilReady: true,
      suppressConflicts: true,
    });
    targetInfo = await pc.describeIndex(TARGET);
  }
  if (targetInfo.dimension !== dimension || targetInfo.metric !== "cosine" || targetInfo.embed) {
    throw new Error("Target index is not a compatible plain dense Voyage index");
  }
  const source = pc.index(SOURCE);
  const target = pc.index(TARGET);
  let progress = fs.existsSync(PROGRESS)
    ? JSON.parse(fs.readFileSync(PROGRESS, "utf8"))
    : { source: SOURCE, target: TARGET, model: MODEL, dimension, paginationToken: null, listed: 0, written: 0, skippedNoText: 0, pages: 0, complete: false };
  if (progress.source !== SOURCE || progress.target !== TARGET || progress.model !== MODEL || progress.dimension !== dimension) {
    throw new Error("Progress file belongs to another migration");
  }
  if (progress.complete) return console.log("Migration already completed", progress);

  // List once into a resumable manifest. Pinecone list pages have a max size
  // of 100 and require a sequential continuation token; embedding work does
  // not, so the pages can then be processed by independent workers.
  let manifest = fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
    : {
        source: SOURCE, target: TARGET, model: MODEL, startToken: progress.paginationToken,
        base: { listed: progress.listed, written: progress.written, skippedNoText: progress.skippedNoText, pages: progress.pages },
        nextToken: progress.paginationToken, pages: [], completed: {}, listedComplete: false,
      };
  if (manifest.source !== SOURCE || manifest.target !== TARGET || manifest.model !== MODEL || manifest.startToken !== progress.paginationToken) {
    throw new Error("Migration manifest does not match progress checkpoint");
  }
  function reconcile() {
    const completed = Object.values(manifest.completed);
    progress.listed = manifest.base.listed + completed.reduce((n, p) => n + p.listed, 0);
    progress.written = manifest.base.written + completed.reduce((n, p) => n + p.written, 0);
    progress.skippedNoText = manifest.base.skippedNoText + completed.reduce((n, p) => n + (p.skippedNoText ?? Math.max(0, p.listed - p.written)), 0);
    progress.pages = manifest.base.pages + completed.length;
  }
  reconcile();
  save(PROGRESS, progress);
  while (!manifest.listedComplete) {
    const page = await retry(() => source.listPaginated({ limit: 100, ...(manifest.nextToken ? { paginationToken: manifest.nextToken } : {}) }), "list");
    const ids = (page.vectors || []).map(v => v.id);
    if (!ids.length && page.pagination?.next) throw new Error("Empty page with continuation token");
    manifest.pages.push(ids);
    manifest.nextToken = page.pagination?.next || null;
    manifest.listedComplete = !manifest.nextToken;
    save(MANIFEST, manifest);
    if (manifest.pages.length % 50 === 0) console.log(`Listed ${manifest.pages.length} remaining pages`);
  }
  console.log(`Listed ${manifest.pages.length} pages; embedding with four resumable workers`);
  let nextPage = 0;
  async function migratePage(ids) {
    // Pinecone fetch uses GET; long encoded article URLs can exceed proxy URI
    // limits when fetched in a single 100-ID request.
    const fetched = { records: {} };
    for (let offset = 0; offset < ids.length; offset += 10) {
      const part = await retry(() => source.fetch(ids.slice(offset, offset + 10)), "fetch");
      Object.assign(fetched.records, part.records || {});
    }
    const records = [];
    for (const id of ids) {
      const metadata = fetched.records?.[id]?.metadata;
      if (typeof metadata?.text !== "string" || !metadata.text.trim()) continue;
      const text = metadata.text;
      // Some legacy vectors stored whole publications in one metadata field.
      // Voyage's batch token limit cannot accept those as a single embedding.
      // Preserve the original ID for pinned lookups and add searchable parts.
      if (text.length <= 4000) {
        records.push({ id, metadata });
      } else {
        for (let start = 0, part = 0; start < text.length; start += 3700, part++) {
          records.push({
            id: part === 0 ? id : `${id}--voyage-part-${part}`,
            metadata: { ...metadata, text: text.slice(start, start + 4000), source_record_id: id },
          });
        }
      }
    }
    const vectors = [];
    const batches = [];
    for (let offset = 0; offset < records.length; offset += 16) batches.push(records.slice(offset, offset + 16));
    for (let offset = 0; offset < batches.length; offset += 2) {
      const pair = batches.slice(offset, offset + 2);
      const responses = await Promise.all(pair.map(batch => embed(batch.map(({ metadata: m }) =>
        `Document: ${m.title || ""}\nSource: ${m.source || m.url || ""}\n\n${m.text}`))));
      for (let k = 0; k < pair.length; k++) {
        for (let i = 0; i < pair[k].length; i++) {
          const item = pair[k][i];
          const m = item.metadata;
          vectors.push({
            id: item.id,
            values: responses[k][i],
            metadata: {
              ...m,
              type: isLawCenterDocument(m.url) ? "law-center-pdf" : m.type === "law-center-pdf" ? "official-policy" : (m.type || "other"),
              model: MODEL,
              embedding_input_type: "document",
            },
          });
        }
      }
    }
    for (let offset = 0; offset < vectors.length; offset += 50) {
      await retry(() => target.upsert(vectors.slice(offset, offset + 50)), "upsert");
    }
    return { written: vectors.length, skippedNoText: ids.length - ids.filter(id => typeof fetched.records?.[id]?.metadata?.text === "string" && fetched.records[id].metadata.text.trim()).length };
  }
  async function worker() {
    while (nextPage < manifest.pages.length) {
      const index = nextPage++;
      if (manifest.completed[index]) continue;
      const ids = manifest.pages[index];
      const result = await migratePage(ids);
      manifest.completed[index] = { listed: ids.length, ...result };
      reconcile();
      // Synchronous checkpoint operations run atomically on the JS event loop.
      save(MANIFEST, manifest);
      save(PROGRESS, progress);
      if (progress.pages % 10 === 0) console.log(`page ${progress.pages}: ${progress.written}/${progress.listed} embedded, ${progress.skippedNoText} without text`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  let stats;
  for (let attempt = 0; attempt < 12; attempt++) {
    stats = await target.describeIndexStats();
    if ((stats.totalRecordCount || 0) >= progress.written) break;
    await pause(5000);
  }
  console.log(`Migration complete: ${JSON.stringify({ ...progress, targetRecordCount: stats.totalRecordCount })}`);
  if ((stats.totalRecordCount || 0) < progress.written) {
    throw new Error("Target index count is lower than written count; inspect indexing lag before cutover");
  }
  progress.complete = true;
  progress.paginationToken = null;
  save(PROGRESS, progress);
}
main().catch(error => { console.error("Migration stopped:", error.message); process.exitCode = 1; });