import test from "node:test";
import assert from "node:assert/strict";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";

test("chat and ingestion share a dedicated plain Voyage index", () => {
  assert.equal(KNOWLEDGE_INDEX, "roa-kb-voyage-law2-20260923");
  assert.equal(KNOWLEDGE_MODEL, "voyage-law-2");
  assert.doesNotThrow(() => assertKnowledgeIndex({ dimension: 1024, metric: "cosine" }));
  for (const info of [
    { dimension: 1024, metric: "cosine", embed: { model: "llama-text-embed-v2" } },
    { dimension: 768, metric: "cosine" },
    { dimension: 1024, metric: "dotproduct" },
  ]) {
    assert.throws(() => assertKnowledgeIndex(info), /plain 1024-dimensional cosine/);
  }
});