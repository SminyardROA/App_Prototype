/**
 * Additive Title 38 statute ingestion into the existing member knowledge index.
 * Dry run: NODE_USE_ENV_PROXY=1 node chatbot/ingest-title38.js
 * Commit:  NODE_USE_ENV_PROXY=1 node chatbot/ingest-title38.js --commit
 * No existing records are deleted. Changed snapshots require editorial review.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pinecone } from "@pinecone-database/pinecone";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";

export const TITLE38_SECTIONS = [
  ["101", "Definitions"],
  ["1110", "Basic entitlement — wartime disability compensation"],
  ["1131", "Basic entitlement — peacetime disability compensation"],
  ["1112", "Presumptions relating to certain diseases and disabilities"],
  ["1113", "Presumptions rebuttable"],
  ["1116", "Presumptions concerning exposure to certain herbicide agents"],
  ["1117", "Compensation for disabilities occurring in Persian Gulf War veterans"],
  ["1119", "Presumptions of toxic exposure"],
  ["1120", "Presumption of service connection for certain diseases associated with exposure to burn pits and other toxins"],
  ["1153", "Aggravation"],
  ["1155", "Authority for schedule for rating disabilities"],
  ["5107", "Claimant responsibility; benefit of the doubt"],
  ["5303", "Certain bars to benefits"],
  ["5303A", "Minimum active-duty service requirement"],
];

export function statuteUrl(section) {
  return `https://www.law.cornell.edu/uscode/text/38/${section}`;
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function decodeEntities(text) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", sect: "§", thinsp: " ", ensp: " ", emsp: " ",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…",
  };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (key[0] === "#") {
      const value = key[1].toLowerCase() === "x"
        ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
        throw new Error("Invalid character reference in statute");
      }
      return String.fromCodePoint(value);
    }
    if (!(key.toLowerCase() in named)) throw new Error(`Unrecognized HTML entity: ${entity}`);
    return named[key.toLowerCase()];
  });
}

function plainText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:div|p|h[1-6])>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseStatute(html, section) {
  const title = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!title || !new RegExp(`^38 U\\.S\\. Code § ${section} - `, "i").test(plainText(title[1]))) {
    throw new Error(`Source did not identify 38 U.S.C. § ${section}`);
  }
  const bodies = [...html.matchAll(/<text>([\s\S]*?)<\/text>/gi)];
  if (bodies.length !== 1) throw new Error(`Missing or ambiguous statute body for § ${section}`);
  // Cornell places legislative credits within <text>, and editorial/amendment
  // notes outside it. Neither is presented as operative statutory language.
  const body = bodies[0][1].split(/<div\b[^>]*class="sourceCredit"[^>]*>/i)[0];
  const text = plainText(body);
  if (text.length < 100 || /\b(?:page not found|access denied)\b/i.test(text)) {
    throw new Error(`Suspicious statute body for § ${section}`);
  }
  // Keep top-level units intact: section 101 has numbered definitions, while
  // other sections have lettered subsections. Child units remain with parents.
  const anchors = section === "101"
    ? /<a name="(\d+)"><\/a>/g
    : /<a name="([a-z])"><\/a>/g;
  const matches = [...body.matchAll(anchors)];
  const preamble = matches.length ? plainText(body.slice(0, matches[0].index)) : "";
  const units = matches.length ? matches.map((match, i) => ({
    subsection: match[1],
    text: plainText(body.slice(match.index, matches[i + 1]?.index ?? body.length)),
  })) : [{ subsection: "", text }];
  if (section === "101") {
    for (const n of ["2", "21", "22", "23", "24"]) {
      if (!units.some(unit => unit.subsection === n)) throw new Error(`Missing definition § 101(${n})`);
    }
    if (!/other than active duty for training/i.test(units.find(u => u.subsection === "21").text)) {
      throw new Error("Active duty exclusion was not preserved");
    }
  }
  return { title: plainText(title[1]), text, preamble, units };
}

function splitLongUnit(text, limit = 6500) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n", end);
      const sentence = text.lastIndexOf(". ", end);
      const boundary = Math.max(paragraph, sentence);
      if (boundary > start + limit / 2) end = boundary + 1;
    }
    pieces.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = Math.max(start + 1, end - 500);
  }
  return pieces;
}

export function statuteChunks(parsed, section) {
  const chunks = parsed.units.flatMap(unit => splitLongUnit(unit.text).map((text, i) => ({
    text: `${parsed.title}${unit.subsection ? ` — subsection (${unit.subsection})` : ""}\n${parsed.preamble}\n${text}`.trim(),
    subsection: unit.subsection,
    part: i + 1,
  })));
  if (section === "101") {
    // A verbatim companion passage puts the exclusion next to the conditional
    // training route. This is source text, not an AI-written legal summary.
    const related = ["2", "21", "22", "23", "24"].map(n =>
      parsed.units.find(unit => unit.subsection === n).text).join("\n\n");
    chunks.push({
      text: `${parsed.title}\n${parsed.preamble}\n${related}`,
      subsection: "2,21,22,23,24",
      part: 1,
    });
  }
  if (chunks.some(chunk => Buffer.byteLength(chunk.text) > 28000)) {
    throw new Error("Statute passage exceeds the safe metadata budget");
  }
  return chunks;
}

export function buildRecords(parsed, section, fetchedAt) {
  const hash = digest(parsed.text);
  return statuteChunks(parsed, section).map((chunk, i) => ({
    id: `usc38-${section}-statute-chunk-${i + 1}`,
    metadata: {
      text: chunk.text,
      url: statuteUrl(section),
      title: parsed.title,
      source: "Cornell Legal Information Institute — U.S. Code statutory text",
      type: "official-policy",
      sourceKind: "us-statute",
      documentIdentity: `38-usc-${section}`,
      titleNumber: "38",
      section,
      subsection: chunk.subsection,
      model: KNOWLEDGE_MODEL,
      embedding_input_type: "document",
      extractionMethod: "cornell-statutory-body-subsections",
      legalStatus: "published-statutory-text",
      currency: "source-snapshot-currentness-not-independently-verified",
      retrievedAt: fetchedAt,
      sourceTextSha256: hash,
    },
  }));
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response;
}

export async function ingestSection(index, records, embed) {
  // Stable short IDs prevent duplicate records on reruns. A changed source
  // snapshot must be reviewed rather than silently leaving old tail chunks.
  const page = await index.listPaginated({ prefix: `usc38-${records[0].metadata.section}-statute-`, limit: 100 });
  if (page.pagination?.next) throw new Error("Unexpectedly large previous statute ingestion");
  const ids = [...new Set([...records.map(r => r.id), ...(page.vectors || []).map(v => v.id)])];
  const previous = (await index.fetch(ids)).records || {};
  for (const record of Object.values(previous)) {
    if (record.metadata?.sourceTextSha256 !== records[0].metadata.sourceTextSha256 ||
        record.metadata?.model !== KNOWLEDGE_MODEL ||
        record.metadata?.url !== records[0].metadata.url) {
      throw new Error("Existing statute snapshot differs; review before replacement");
    }
  }
  if (Object.keys(previous).some(id => !records.some(r => r.id === id))) {
    throw new Error("Existing statute contains unexpected tail chunks; review required");
  }
  const pending = records.filter(r => !previous[r.id]?.metadata?.text ||
    previous[r.id].metadata.text !== r.metadata.text);
  for (let i = 0; i < pending.length; i += 8) {
    const batch = pending.slice(i, i + 8);
    const vectors = await embed(batch.map(r => r.metadata.text));
    if (vectors.length !== batch.length || vectors.some(v =>
      !Array.isArray(v) || v.length !== 1024 || v.some(n => !Number.isFinite(n)))) {
      throw new Error("Invalid Voyage embeddings; no batch written");
    }
    await index.upsert(batch.map((r, n) => ({ ...r, values: vectors[n] })));
  }
  return { added: pending.length, skipped: records.length - pending.length };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const fetchedAt = new Date().toISOString();
  const outDir = resolve("generated-artifacts/title38-ingestion");
  mkdirSync(outDir, { recursive: true });
  const prepared = [];
  // Finish extraction validation before any external writes.
  for (const [section] of TITLE38_SECTIONS) {
    const response = await request(statuteUrl(section));
    if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("Expected statutory HTML");
    const parsed = parseStatute(await response.text(), section);
    const records = buildRecords(parsed, section, fetchedAt);
    prepared.push({ section, records });
    console.log(`Prepared 38 U.S.C. § ${section}: ${records.length} passages`);
  }
  writeFileSync(resolve(outDir, "prepared.json"), JSON.stringify(prepared, null, 2));
  if (!commit) {
    console.log("Dry run only. Use --commit to add these passages to the member index.");
    return;
  }
  if (!process.env.VOYAGE_API_KEY || !process.env.PINECONE_API_KEY) {
    throw new Error("Required ingestion credentials are not configured");
  }
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  assertKnowledgeIndex(await pc.describeIndex(KNOWLEDGE_INDEX));
  const index = pc.index(KNOWLEDGE_INDEX).namespace("");
  const embed = async texts => {
    const response = await request("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: KNOWLEDGE_MODEL, input: texts, input_type: "document" }),
    });
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error("Voyage response has no embeddings");
    const data = result.data.toSorted((a, b) => a.index - b.index);
    if (data.some((item, i) => item.index !== i)) throw new Error("Voyage embedding order is invalid");
    return data.map(item => item.embedding);
  };
  const results = [];
  for (const { section, records } of prepared) {
    const result = await ingestSection(index, records, embed);
    results.push({ section, ...result, expected: records.length });
    console.log(`Indexed § ${section}: ${result.added} added, ${result.skipped} already present`);
  }
  writeFileSync(resolve(outDir, "result.json"), JSON.stringify({ fetchedAt, index: KNOWLEDGE_INDEX, namespace: "", results }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Title 38 ingestion failed: ${error.message}`); process.exitCode = 1; });
}
