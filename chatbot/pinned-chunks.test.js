import test from "node:test";
import assert from "node:assert/strict";
import { PINNED_ID_GROUPS, verifyPinnedChunks } from "./pinned-chunks.js";

test("pinned ID checker reports missing IDs by section and checks every group", async () => {
  const absent = PINNED_ID_GROUPS[2].ids[0];
  const batches = [];
  const groups = await verifyPinnedChunks({
    fetch: async ids => {
      batches.push(ids);
      return { records: Object.fromEntries(ids.filter(id => id !== absent)
        .map(id => [id, { metadata: { text: "Verified source text" } }])) };
    },
  });
  assert.deepEqual(groups.find(group => group.label.includes("FMR")).missing, [absent]);
  assert.equal(groups.flatMap(group => group.missing).length, 1);
  assert.deepEqual(new Set(batches.flat()), new Set(PINNED_ID_GROUPS.flatMap(group => group.ids)));
  assert.ok(batches.every(batch => batch.length <= 8));
});