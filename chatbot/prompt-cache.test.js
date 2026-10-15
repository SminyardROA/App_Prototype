import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { cachedSystemBlocks } from "./prompt-cache.js";

test("only shared instructions receive a five-minute Anthropic cache breakpoint", () => {
  const dynamic = "\n\nMode: pay. Question: member-specific text.";
  const system = cachedSystemBlocks(config.systemPrompt, dynamic);
  assert.deepEqual(system[0], {
    type: "text",
    text: config.systemPrompt,
    cache_control: { type: "ephemeral" },
  });
  assert.deepEqual(system[1], { type: "text", text: dynamic });
  assert.equal(system.map(block => block.text).join(""), config.systemPrompt + dynamic);
  assert.equal(JSON.stringify(system[0]).includes("member-specific text"), false);
});

test("prompt caching rejects an empty shared prefix", () => {
  assert.throws(() => cachedSystemBlocks("  ", "per-request text"), TypeError);
});

test("installed Anthropic SDK serializes the explicit cache block without caching a question", async () => {
  let request;
  const client = new Anthropic({
    apiKey: "test-only",
    maxRetries: 0,
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      throw new Error("Stopped before network request");
    },
  });
  try {
    await client.messages.create({
      model: config.claudeModel,
      max_tokens: 32,
      thinking: { type: "disabled" },
      system: cachedSystemBlocks(config.systemPrompt, "Turn-specific instruction"),
      messages: [{ role: "user", content: "Example member question" }],
    });
  } catch {
    // The injected fetch deliberately stops the request after serialization.
  }
  assert.ok(request, "Anthropic SDK should serialize the request");
  assert.equal(request.model, "claude-sonnet-5");
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.deepEqual(request.system[0].cache_control, { type: "ephemeral" });
  assert.equal(request.system[1].cache_control, undefined);
  assert.equal(request.cache_control, undefined);
  assert.equal(JSON.stringify(request.system).includes("Example member question"), false);
});