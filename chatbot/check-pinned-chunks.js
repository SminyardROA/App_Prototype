import { Pinecone } from "@pinecone-database/pinecone";
import { KNOWLEDGE_INDEX, assertKnowledgeIndex } from "./knowledge-index.js";
import { verifyPinnedChunks } from "./pinned-chunks.js";

if (!process.env.PINECONE_API_KEY) {
  console.error("Pinecone is not configured; pinned chunks cannot be checked.");
  process.exitCode = 2;
} else {
  try {
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    assertKnowledgeIndex(await pinecone.describeIndex(KNOWLEDGE_INDEX));
    const groups = await verifyPinnedChunks(pinecone.index(KNOWLEDGE_INDEX));
    for (const group of groups) {
      console.log(`${group.label}: ${group.present.length} present, ${group.missing.length} missing`);
      for (const id of group.present) console.log(`  OK      ${id}`);
      for (const id of group.missing) console.log(`  MISSING ${id}`);
    }
    if (groups.some(group => group.missing.length)) process.exitCode = 1;
  } catch {
    console.error("Pinned chunk check failed; could not verify the index.");
    process.exitCode = 2;
  }
}