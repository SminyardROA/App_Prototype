// Shared raw search transport. Chat and source packs use the same dense index,
// query vector and Pinecone metadata settings; this never writes to the index.
export class KnowledgeSearchError extends Error {
  constructor(message) {
    super(message);
    this.name = "KnowledgeSearchError";
  }
}

async function pineconeRequest(client, endpoint, body, signal) {
  const response = await client.fetch(`https://${client.indexHost}/${endpoint}`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2024-10",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  // Never include a provider error body: it may echo credentials or queries.
  if (!response.ok) {
    throw new KnowledgeSearchError(`Pinecone ${endpoint} failed (HTTP ${response.status})`);
  }
  return response.json();
}

export function queryKnowledgeIndex(client, { vector, topK, namespace, filter, signal }) {
  return pineconeRequest(client, "query", {
    vector,
    includeMetadata: true,
    includeValues: false,
    topK,
    namespace: namespace === undefined ? "" : namespace,
    ...(filter === undefined ? {} : { filter }),
  }, signal);
}

export async function knowledgeNamespaces(client, signal, { includeDefault = true } = {}) {
  const stats = await pineconeRequest(client, "describe_index_stats", {}, signal);
  if (!stats || typeof stats.namespaces !== "object" || stats.namespaces === null ||
      Array.isArray(stats.namespaces)) {
    throw new KnowledgeSearchError("Pinecone namespace inventory was invalid");
  }
  // Legacy callers include the default even when it has no inventory entry.
  // Explicit source-pack selection must instead validate against real entries.
  return [...new Set([...(includeDefault ? [""] : []), ...Object.keys(stats.namespaces)])];
}
