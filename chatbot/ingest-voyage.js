/**
 * ROA Law Review Re-Ingestion Script — Voyage AI
 * ================================================
 * Fetches catalog documents, extracts text via pdftotext,
 * embeds with voyage-law-2, and upserts into the dedicated Voyage index.
 *
 * Usage:    node ingest-voyage.js
 * One URL:  node ingest-voyage.js --url https://www.va.gov/housing-assistance/home-loans/eligibility/
 * Resume:   Re-run — completed URLs are skipped via ingest-progress.json
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";
import { canonicalSourceIdentity } from "./source-provenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const VOYAGE_MODEL    = KNOWLEDGE_MODEL;
const PINECONE_INDEX  = KNOWLEDGE_INDEX;
const CHUNK_SIZE      = 1200;   // characters per chunk
const CHUNK_OVERLAP   = 150;    // overlap between consecutive chunks
const VOYAGE_BATCH    = 8;      // texts per Voyage embed call
const PINECONE_BATCH  = 100;    // vectors per Pinecone upsert
const CONCURRENCY     = 4;      // parallel PDF fetches
const DELAY_MS        = 400;    // ms pause between Voyage API calls
const PROGRESS_FILE   = path.join(__dirname, "ingest-progress.json");
const ARTICLES_FILE   = path.join(__dirname, "lr-articles.json");

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")));
  }
  return new Set();
}

function saveProgress(done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...done], null, 2));
}

function chunkText(text) {
  // Normalise whitespace — pdftotext can leave lots of blank lines
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 80) chunks.push(chunk);
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

export function chunkDocumentPages(text, format = "pdf") {
  if (format === "html") return chunkText(text).map(text => ({ text }));
  return text.split("\f").flatMap((page, i) =>
    chunkText(page).map(text => ({ text, pageStart: i + 1, pageEnd: i + 1 })));
}

export async function verifyExistingArticle(index, article, verifiedSources = []) {
  const known = verifiedSources.find(source => source.sourceKind === "roa-analysis" &&
    canonicalSourceIdentity(source.url) === canonicalSourceIdentity(article.url));
  const id = article.indexedRecordId || known?.indexedRecordId;
  if (!id) return false;
  const record = (await index.fetch([id])).records?.[id];
  if (!record?.metadata?.text?.trim() || record.metadata.model !== KNOWLEDGE_MODEL ||
      canonicalSourceIdentity(record.metadata.url) !== canonicalSourceIdentity(article.url)) {
    throw new Error("Previously indexed catalog source could not be verified; refusing duplicate ingestion");
  }
  return true;
}

async function fetchAndExtractText(url, format = "pdf") {
  // Official military publication hosts commonly block bot User-Agents.
  const hostname = new URL(url).hostname.toLowerCase();
  const isOfficialMilitarySource =
    hostname.endsWith(".mil") ||
    hostname.endsWith(".gov");
  const headers = isOfficialMilitarySource
    ? {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/pdf,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `${new URL(url).origin}/`,
      }
    : { "User-Agent": "ROABot/1.0 (roa.org)" };

  let resp;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(35000),
      });
      if (resp.ok) break;
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await sleep(1000 * attempt);
  }
  if (!resp?.ok) throw lastError || new Error("Fetch failed");

  const buf = Buffer.from(await resp.arrayBuffer());
  if (format === "html") {
    if (!resp.headers.get("content-type")?.includes("text/html")) {
      throw new Error(`Expected HTML, received ${resp.headers.get("content-type") || "unknown content type"}`);
    }
    return buf
      .toString("utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  if (!buf.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new Error(`Expected PDF, received ${resp.headers.get("content-type") || "unknown content type"}`);
  }
  const tmpPdf = path.join(os.tmpdir(), `roa-lr-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const tmpTxt = tmpPdf.replace(".pdf", ".txt");

  try {
    fs.writeFileSync(tmpPdf, buf);
    execSync(`pdftotext "${tmpPdf}" "${tmpTxt}"`, { timeout: 20000 });
    return fs.readFileSync(tmpTxt, "utf8");
  } finally {
    if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    if (fs.existsSync(tmpTxt)) fs.unlinkSync(tmpTxt);
  }
}

async function embedTexts(texts) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: texts, input_type: "document" }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Voyage ${resp.status}: ${JSON.stringify(err)}`);
  }
  const body = await resp.json();
  return body.data.map(d => d.embedding);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 ROA Law Review Voyage Re-Ingestion");
  console.log(`   Model: ${VOYAGE_MODEL} | Chunk: ${CHUNK_SIZE}ch overlap ${CHUNK_OVERLAP}ch | Concurrency: ${CONCURRENCY}\n`);

  if (!process.env.VOYAGE_API_KEY)    throw new Error("VOYAGE_API_KEY not set");
  if (!process.env.PINECONE_API_KEY)  throw new Error("PINECONE_API_KEY not set");

  const articles = JSON.parse(fs.readFileSync(ARTICLES_FILE, "utf8"));
  const done = loadProgress();
  const urlFlag = process.argv.indexOf("--url");
  const onlyUrl = urlFlag < 0 ? null : process.argv[urlFlag + 1];
  if (urlFlag >= 0 && (!onlyUrl || !articles.some(article => article.url === onlyUrl))) {
    throw new Error("The requested URL must appear in lr-articles.json");
  }
  let remaining = articles.filter(a => !done.has(a.url) && (!onlyUrl || a.url === onlyUrl));

  console.log(`📚 ${articles.length} total articles | ${done.size} already done | ${remaining.length} to process\n`);

  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  assertKnowledgeIndex(await pc.describeIndex(PINECONE_INDEX));
  const index = pc.index(PINECONE_INDEX).namespace("");
  const verifiedSources = JSON.parse(fs.readFileSync(path.join(__dirname, "verified-sources.json"), "utf8"));
  const pending = [];
  for (const article of remaining) {
    if (await verifyExistingArticle(index, article, verifiedSources)) done.add(article.url);
    else pending.push(article);
  }
  saveProgress(done);
  remaining = pending;

  let processed = 0, errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(article =>
        fetchAndExtractText(article.url, article.format).then(text => ({ article, text }))
      )
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`  ❌ Fetch/parse failed: ${result.reason?.message}`);
        errors++;
        continue;
      }

      const { article, text } = result.value;
      const chunks = chunkDocumentPages(text, article.format);

      if (chunks.length === 0) {
        console.warn(`  ⚠️  No text extracted: ${article.url}`);
        // A zero-text document has no searchable record; retry it next run.
        continue;
      }

      // Embed chunks in sub-batches
      const allVectors = [];
      let embedError = false;
      for (let ci = 0; ci < chunks.length; ci += VOYAGE_BATCH) {
        const subChunks = chunks.slice(ci, ci + VOYAGE_BATCH);
        try {
          const embeddingTexts = subChunks.map(
            chunk => `Document: ${article.title}\nSource: ${article.source || "ROA Service Members Law Center"}\n\n${chunk.text}`
          );
          const embeddings = await embedTexts(embeddingTexts);
          for (let j = 0; j < subChunks.length; j++) {
            const chunkIdx = ci + j + 1;
            const safeUrl = encodeURIComponent(article.url);
            allVectors.push({
              id: `voyage-${safeUrl}-chunk-${chunkIdx}`,
              values: embeddings[j],
              metadata: {
                ...subChunks[j],
                url: article.url,
                title: article.title,
                source: article.source || "ROA Service Members Law Center",
                type: article.source === "ROA Service Members Law Center"
                  ? "law-center-pdf"
                  : "official-policy",
                model: VOYAGE_MODEL,
                embedding_input_type: "document",
                documentIdentity: article.documentIdentity || canonicalSourceIdentity(article.url),
                ...(article.documentDate ? { documentDate: article.documentDate } : {}),
                ...(article.legalStatus ? { legalStatus: article.legalStatus } : {}),
                currency: article.currency || "indexed-snapshot-date-unknown",
                extractionMethod: article.format === "html" ? "html-text" : "pdftotext-pages",
              },
            });
          }
          await sleep(DELAY_MS);
        } catch (e) {
          console.error(`  ❌ Embed error (${article.title}): ${e.message}`);
          errors++;
          embedError = true;
          break;
        }
      }

      if (embedError) continue;

      // Upsert to Pinecone
      for (let vi = 0; vi < allVectors.length; vi += PINECONE_BATCH) {
        await index.upsert(allVectors.slice(vi, vi + PINECONE_BATCH));
      }

      done.add(article.url);
      saveProgress(done);
      processed++;

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / (elapsed / 60);
      const etaMin = ((remaining.length - processed) / rate).toFixed(0);
      console.log(
        `  ✅ [${processed + done.size - processed}/${remaining.length}] ${article.title} — ${chunks.length} chunks | ${rate.toFixed(1)}/min | ETA ~${etaMin}min`
      );
    }

  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n🏁 Ingestion complete in ${elapsed} minutes`);
  console.log(`   Processed: ${processed} | Errors: ${errors} | Total done: ${done.size}/${articles.length}`);
  if (errors > 0) throw new Error(`Ingestion completed with ${errors} error(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
}
