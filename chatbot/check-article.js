/**
 * check-article.js — Look up whether an article is ingested in Pinecone
 * =====================================================================
 * Usage:  node check-article.js <search term>
 *
 * The search term is matched against article URLs and titles (case-insensitive).
 * Examples:
 *   node check-article.js 24030          ← by case/doc number
 *   node check-article.js 090-LR         ← by filename fragment
 *   node check-article.js USERRA         ← by keyword in title
 *   node check-article.js 2026           ← find all 2026 articles
 */

import { Pinecone } from "@pinecone-database/pinecone";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { KNOWLEDGE_INDEX, assertKnowledgeIndex } from "./knowledge-index.js";
import { verifyExistingArticle } from "./ingest-voyage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PINECONE_INDEX = KNOWLEDGE_INDEX;
const ARTICLES_FILE  = path.join(__dirname, "lr-articles.json");

async function main() {
  const searchTerm = process.argv[2];
  if (!searchTerm) {
    console.log("Usage:  node check-article.js <search term>");
    console.log("Examples:");
    console.log("  node check-article.js 24030      ← case/doc number");
    console.log("  node check-article.js 2026        ← all 2026 articles");
    console.log("  node check-article.js USERRA      ← keyword in title");
    process.exit(1);
  }

  if (!process.env.PINECONE_API_KEY) {
    console.error("❌ PINECONE_API_KEY not set");
    process.exit(1);
  }

  const articles = JSON.parse(fs.readFileSync(ARTICLES_FILE, "utf8"));
  const term = searchTerm.toLowerCase();

  const matches = articles.filter(a =>
    a.url.toLowerCase().includes(term) ||
    (a.title && a.title.toLowerCase().includes(term))
  );

  if (matches.length === 0) {
    console.log(`\n❌  No articles found matching "${searchTerm}" in lr-articles.json\n`);
    process.exit(0);
  }

  console.log(`\n🔍  "${searchTerm}" — ${matches.length} match(es) found in article list\n`);

  const pc    = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  assertKnowledgeIndex(await pc.describeIndex(PINECONE_INDEX));
  const index = pc.index(PINECONE_INDEX).namespace("");

  let inPinecone = 0, missing = 0;

  for (const article of matches) {
    const prefix  = `voyage-${encodeURIComponent(article.url)}-chunk-`;
    let   chunkCount = 0;

    try {
      if (article.indexedRecordId && await verifyExistingArticle(index, article)) {
        const record = (await index.fetch([article.indexedRecordId])).records[article.indexedRecordId];
        chunkCount = record.metadata.chunkCount || 1;
      } else {
      // listPaginated fetches one page of vector IDs matching this prefix
      let paginationToken;
      do {
        const page = await index.listPaginated({ prefix, paginationToken });
        chunkCount += (page.vectors ?? []).length;
        paginationToken = page.pagination?.next;
      } while (paginationToken);
      }
    } catch (e) {
      console.error(`  ⚠️  Pinecone error for ${article.url}: ${e.message}`);
    }

    if (chunkCount > 0) {
      console.log(`  ✅  ${article.title}`);
      console.log(`      ${article.url}`);
      console.log(`      ${chunkCount} chunk(s) in Pinecone\n`);
      inPinecone++;
    } else {
      console.log(`  ❌  ${article.title}`);
      console.log(`      ${article.url}`);
      console.log(`      NOT found in Pinecone\n`);
      missing++;
    }
  }

  console.log(`─────────────────────────────────────────`);
  console.log(`  Total matches : ${matches.length}`);
  console.log(`  In Pinecone   : ${inPinecone}`);
  console.log(`  Missing       : ${missing}`);
  console.log();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
