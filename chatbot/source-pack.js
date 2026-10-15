import { timingSafeEqual } from "node:crypto";
import { KnowledgeSearchError, knowledgeNamespaces, queryKnowledgeIndex } from "./knowledge-search.js";

const MAX_QUERIES = 40;
const MAX_QUERY_LENGTH = 2000;
const TIMEOUT_MS = 20000;
const CONCURRENCY = 4;
const DOCUMENT_TYPES = new Set(["report", "law", "testimony", "policy", "article", "data", "other"]);

class SourcePackRequestError extends Error {}

export function publicationDateNumber(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SourcePackRequestError("Publication date bounds must be valid dates in YYYY-MM-DD format");
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new SourcePackRequestError("Publication date bounds must be valid dates in YYYY-MM-DD format");
  }
  return year * 10000 + month * 100 + day;
}

function metadataFilter(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["doc_type", "publication_date"].includes(key))) {
    throw new SourcePackRequestError("filter must be an object containing only doc_type and/or publication_date");
  }
  const filter = {};
  if (input.doc_type !== undefined) {
    if (!DOCUMENT_TYPES.has(input.doc_type)) {
      throw new SourcePackRequestError("filter.doc_type must be report, law, testimony, policy, article, data, or other");
    }
    filter.doc_type = { $eq: input.doc_type };
  }
  if (input.publication_date !== undefined) {
    const range = input.publication_date;
    if (!range || typeof range !== "object" || Array.isArray(range) ||
        !Object.keys(range).length || Object.keys(range).some(key => !["from", "to"].includes(key))) {
      throw new SourcePackRequestError("filter.publication_date must contain from and/or to dates in YYYY-MM-DD format");
    }
    const bounds = {};
    if (Object.hasOwn(range, "from")) bounds.$gte = publicationDateNumber(range.from);
    if (Object.hasOwn(range, "to")) bounds.$lte = publicationDateNumber(range.to);
    if (bounds.$gte !== undefined && bounds.$lte !== undefined && bounds.$gte > bounds.$lte) {
      throw new SourcePackRequestError("filter.publication_date.from must be on or before to");
    }
    filter.publication_date_num = bounds;
  }
  return Object.keys(filter).length ? filter : undefined;
}

export function sourcePackAuthentication(getToken = () => process.env.SOURCE_PACK_TOKEN) {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const expected = getToken();
    if (!expected) return res.status(404).json({ error: "Not found" });
    const supplied = req.get("x-source-pack-token");
    if (typeof supplied !== "string") return res.status(401).json({ error: "Unauthorized" });
    const actualBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}

function validateBody(body) {
  if (!body || !Array.isArray(body.queries) ||
      body.queries.length < 1 || body.queries.length > MAX_QUERIES) {
    return { error: "queries must be an array containing 1 to 40 strings" };
  }
  if (body.queries.some(query => typeof query !== "string" ||
      !query.trim() || query.length > MAX_QUERY_LENGTH)) {
    return { error: "Each query must be a non-empty string of at most 2000 characters" };
  }
  const topK = body.topK === undefined ? 8 : body.topK;
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
    return { error: "topK must be an integer between 1 and 20" };
  }
  if (body.namespaces !== undefined && (!Array.isArray(body.namespaces) ||
      body.namespaces.length === 0 || body.namespaces.some(namespace => typeof namespace !== "string"))) {
    return { error: 'namespaces must be a non-empty array of strings; use "" for the default namespace' };
  }
  try {
    return {
      queries: body.queries,
      topK,
      namespaces: body.namespaces === undefined ? undefined : [...new Set(body.namespaces)],
      filter: metadataFilter(body.filter),
    };
  } catch (error) {
    if (error instanceof SourcePackRequestError) return { error: error.message };
    throw error;
  }
}

function firstString(metadata, fields) {
  for (const field of fields) {
    if (typeof metadata[field] === "string" && metadata[field]) return metadata[field];
  }
  return null;
}

export function sourcePackMatches(candidates, topK) {
  const sorted = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seen = new Set();
  const matches = [];
  for (const match of sorted) {
    const metadata = match.metadata || {};
    const text = firstString(metadata, ["text", "chunk_text", "content"]);
    // A citation pack needs a passage. Preserve its exact text, without
    // truncating or normalizing it; duplicate means an exact string match.
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const publicationDate = firstString(metadata, ["publication_date", "published_date"]);
    const precision = firstString(metadata, ["publication_date_precision"]);
    const docType = firstString(metadata, ["doc_type"]);
    matches.push({
      score: match.score ?? null,
      text,
      source_title: firstString(metadata, ["title", "source_title", "filename", "file_name"]),
      source_url_or_file: firstString(metadata, ["url", "source_url", "file", "file_path", "filename", "source"]),
      date: publicationDate ?? metadata.date ??
        metadata.effective_date ?? metadata.ingestionDate ?? metadata.ingestion_date ?? null,
      ...(publicationDate ? { publication_date: publicationDate } : {}),
      ...(precision ? { publication_date_precision: precision } : {}),
      ...(docType ? { doc_type: docType } : {}),
      namespace: match.namespace,
      chunk_id: match.id,
      metadata, // Preserve every original field, including the aliases above.
    });
    if (matches.length === topK) break;
  }
  return matches;
}

async function collectSourcePack(client, { queries, topK, namespaces: requestedNamespaces, filter }, signal) {
  const inventory = await knowledgeNamespaces(client, signal, { includeDefault: false });
  if (requestedNamespaces !== undefined && requestedNamespaces.some(namespace => !inventory.includes(namespace))) {
    // Reject the entire selection before embedding/search; never fall back to
    // other namespaces or silently return only part of the requested coverage.
    throw new SourcePackRequestError('One or more requested namespaces do not exist in the index inventory; use "" for the default namespace');
  }
  const namespaces = requestedNamespaces ?? [...new Set(["", ...inventory])];
  const results = new Array(queries.length);
  let next = 0;
  // Bound outbound calls and preserve input order even when searches complete
  // out of order. Each query is embedded once and shared across namespaces.
  const worker = async () => {
    while (next < queries.length) {
      signal.throwIfAborted();
      const position = next++;
      const query = queries[position];
      let vector;
      try {
        vector = await client.embed(query, { signal });
      } catch {
        signal.throwIfAborted();
        throw new KnowledgeSearchError("Voyage query embedding failed");
      }
      const candidates = [];
      for (const namespace of namespaces) {
        signal.throwIfAborted();
        const response = await queryKnowledgeIndex(client, { vector, topK, namespace, filter, signal });
        if (!Array.isArray(response?.matches)) {
          throw new KnowledgeSearchError("Pinecone search returned invalid matches");
        }
        candidates.push(...response.matches.map(match => ({ ...match, namespace })));
      }
      results[position] = { query, matches: sourcePackMatches(candidates, topK) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker));
  return { results, namespaces_searched: namespaces.length, searched_namespaces: namespaces };
}

export function sourcePackHandler({
  getClient,
  timeoutMs = TIMEOUT_MS,
  logCount = count => console.log(`[source-pack] query count: ${count}`),
}) {
  return async (req, res) => {
    const body = validateBody(req.body);
    if (body.error) return res.status(400).json({ error: body.error });
    const client = getClient();
    if (!client?.indexHost || typeof client.embed !== "function" ||
        typeof client.fetch !== "function") {
      return res.status(503).json({ error: "Knowledge-base retrieval is unavailable" });
    }
    logCount(body.queries.length);
    const controller = new AbortController();
    let timedOut = false;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("Source-pack search aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();
    const onClose = () => controller.abort();
    res.once("close", onClose);
    try {
      const pack = await Promise.race([
        collectSourcePack(client, body, controller.signal),
        aborted,
      ]);
      if (!res.destroyed) res.json(pack);
    } catch (error) {
      if (res.destroyed) return;
      const status = timedOut ? 504 : error instanceof SourcePackRequestError ? 400 : 502;
      const message = timedOut
        ? "Source-pack search timed out after 20 seconds; try fewer queries"
        : error instanceof KnowledgeSearchError || error instanceof SourcePackRequestError
          ? error.message
          : "Source-pack retrieval failed; please retry";
      res.status(status).json({ error: message });
    } finally {
      clearTimeout(timer);
      res.removeListener("close", onClose);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort(); // Cancel sibling calls after any upstream failure.
    }
  };
}
