import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { alertMaintainers, compareStatutes, digest, statuteText, sections, sectionUrl } from "./check-scra-statutes.js";

const page = (section, text, metadata = "20260924") =>
  `<!-- documentid:50_${section} currentthrough:${metadata} --><!-- field-start:statute --><p>${text}</p><!-- field-end:statute --><!-- field-start:amendment-note -->Different notes<!-- field-end:amendment-note -->`;
const body = "A statutory paragraph containing more than one thousand characters. ".repeat(20);

test("hashes statutory text only, ignoring markup and metadata", () => {
  const first = statuteText(page("3911", body), "3911");
  assert.equal(first, statuteText(page("3911", `<span>${body}</span>`, "20261001"), "3911"));
  assert.notEqual(digest(first), digest(statuteText(page("3911", body + " Changed.", "20261001"), "3911")));
  assert.throws(() => statuteText(page("3937", body), "3911"), /did not return/);
  assert.throws(() => statuteText(page("3911", "short"), "3911"), /Suspiciously short/);
  assert.throws(() => statuteText(page("3911", body).replace("field-end:statute", "field-end:notes"), "3911"), /Missing or ambiguous/);
});

test("checks all three sections, flags changed text and failed fetches independently", async () => {
  const baseline = Object.fromEntries(sections.map(s => [s, digest(statuteText(page(s, body), s))]));
  const { changes, failures } = await compareStatutes(baseline, async url => {
    const section = sections.find(s => url === sectionUrl(s));
    if (section === "3937") return { ok: false, status: 503 };
    return { ok: true, text: async () => page(section, body + (section === "3955" ? " Amendment." : "")) };
  });
  assert.deepEqual(changes.map(c => c.section), ["3955"]);
  assert.deepEqual(failures.map(f => f.section), ["3937"]);
  assert.match(failures[0].reason, /HTTP 503/);
});

test("opens one actionable issue, then reuses it on later checks", async () => {
  const issues = [];
  const requests = [];
  const api = async (url, options) => {
    requests.push({ url, options });
    if (options.method === "POST") {
      issues.push(JSON.parse(options.body));
      return { ok: true };
    }
    return { ok: true, json: async () => issues };
  };
  const change = [{ section: "3911", url: sectionUrl("3911"), hash: "a".repeat(64) }];
  // This unit test must not depend on the checkout's remotes (task forks
  // legitimately have no origin). Use a local fixture; never contact GitHub.
  const cwd = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), "scra-repository-"));
  try {
    execFileSync("git", ["init", "-q", fixture]);
    execFileSync("git", ["-C", fixture, "remote", "add", "origin", "https://github.com/fixture/scra.git"]);
    process.chdir(fixture);
    await alertMaintainers(change, "test-token", api);
    await alertMaintainers(change, "test-token", api);
  } finally {
    process.chdir(cwd);
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /legal counsel/);
  assert.match(issues[0].body, /multisource-baseline/);
  assert.match(requests[0].options.headers.Authorization, /Bearer test-token/);
  await assert.rejects(() => alertMaintainers(change, null, api), /GITHUB_TOKEN/);
});