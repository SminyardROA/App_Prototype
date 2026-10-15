// Test-only deterministic provider responses. Production never imports this.
import { before, after } from "node:test";
import Anthropic from "@anthropic-ai/sdk";

export function installFixtureVaReviewer() {
  let original;
  before(() => {
    original = Anthropic.Messages.prototype.create;
    Anthropic.Messages.prototype.create = async params => fixtureVaReview(params);
  });
  after(() => { Anthropic.Messages.prototype.create = original; });
}

export function fixtureVaReview(params) {
  const { units, passages } = JSON.parse(params.messages[0].content);
  return {
    stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: "text", text: JSON.stringify({ units: units.map(unit => {
      const doc = passages.find(doc => unit.text.includes(doc.url));
      return { id: unit.id, status: doc ? "supported" : "nonclaim",
        evidence: doc ? [{ url: doc.url, quote: doc.text }] : [] };
    }) }) }],
  };
}
