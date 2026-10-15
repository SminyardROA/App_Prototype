// A plain dense index: every document vector is voyage-law-2 (document input),
// and searches use the same model with query input. The legacy integrated
// index is retained separately for comparison, not used by live retrieval.
export const KNOWLEDGE_INDEX = "roa-kb-voyage-law2-20260923";
export const KNOWLEDGE_MODEL = "voyage-law-2";

export function assertKnowledgeIndex(info) {
  if (info?.dimension !== 1024 || info?.metric !== "cosine" || info?.embed) {
    throw new Error("Knowledge index must be a plain 1024-dimensional cosine index for voyage-law-2");
  }
}