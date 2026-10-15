// Cache only the fixed instructions shared by every chat request. Keep mode,
// retrieval, conversation, and member-specific instructions outside this block.
export function cachedSystemBlocks(baseInstructions, requestInstructions) {
  if (typeof baseInstructions !== "string" || !baseInstructions.trim()) {
    throw new TypeError("Base system instructions are required for prompt caching");
  }
  return [
    { type: "text", text: baseInstructions, cache_control: { type: "ephemeral" } },
    { type: "text", text: requestInstructions },
  ];
}