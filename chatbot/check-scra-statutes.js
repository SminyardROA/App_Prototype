import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const sections = ["3911", "3937", "3955"];
const baselinePath = new URL("./scra-statute-baseline.json", import.meta.url);
const titlePrefix = "SCRA statute change: 50 U.S.C. § ";

export function sectionUrl(section) {
  return `https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A${section}%20edition%3Aprelim%29`;
}

// Only the OLRC statutory field is compared. Navigation, "current through"
// metadata, editorial notes, and publication formatting are not legal changes.
export function statuteText(html, section) {
  if (!html.includes(`documentid:50_${section} `)) {
    throw new Error(`OLRC did not return Title 50 section ${section}`);
  }
  const match = html.match(/<!-- field-start:statute -->([\s\S]*?)<!-- field-end:statute -->/g);
  if (!match || match.length !== 1) throw new Error(`Missing or ambiguous statutory text for § ${section}`);
  const text = match[0]
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code) => {
      if (code.startsWith("#")) {
        const number = code[1].toLowerCase() === "x"
          ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return String.fromCodePoint(number);
      }
      const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", sect: "§" };
      if (!(code.toLowerCase() in entities)) throw new Error(`Unknown OLRC entity ${entity}`);
      return entities[code.toLowerCase()];
    })
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 1000) throw new Error(`Suspiciously short statutory text for § ${section}`);
  return text;
}

export function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function compareStatutes(baseline, fetcher = fetch) {
  const changes = [];
  const failures = [];
  for (const section of sections) {
    try {
      if (!/^[0-9a-f]{64}$/.test(baseline[section])) throw new Error(`Missing reviewed baseline for § ${section}`);
      const url = sectionUrl(section);
      const response = await fetcher(url, {
        headers: { "User-Agent": "Mozilla/5.0 (SCRA statutory change monitor)" },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`OLRC returned HTTP ${response.status}`);
      const hash = digest(statuteText(await response.text(), section));
      if (hash !== baseline[section]) changes.push({ section, url, hash });
    } catch (error) {
      failures.push({ section, reason: error.message });
    }
  }
  return { changes, failures };
}

function repository() {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error("origin must point to a GitHub repository for issue alerts");
  return match[1];
}

export async function alertMaintainers(changes, token, apiFetch = fetch) {
  if (!changes.length) return;
  if (!token) throw new Error("GITHUB_TOKEN is missing; cannot alert maintainers");
  const repo = repository();
  const endpoint = `https://api.github.com/repos/${repo}/issues`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "roa-scra-statute-monitor",
  };
  const issues = [];
  for (let page = 1; page <= 20; page++) {
    const open = await apiFetch(`${endpoint}?state=open&per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(20000) });
    if (!open.ok) throw new Error(`GitHub issue lookup failed (HTTP ${open.status})`);
    const batch = await open.json();
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub issue lookup response");
    issues.push(...batch);
    if (batch.length < 100) break;
    if (page === 20) throw new Error("Too many open issues to safely deduplicate SCRA alerts");
  }
  for (const { section, url, hash } of changes) {
    const title = `${titlePrefix}${section} differs from reviewed guidance`;
    if (issues.some(issue => issue.title === title)) {
      console.error(`ALERT: § ${section} still differs; existing GitHub issue is open. ${url}`);
      continue;
    }
    const body = `The current official statutory text at ${url} differs from the reviewed snapshot in chatbot/scra-statute-baseline.json.\n\nReviewed SHA-256: ${JSON.parse(readFileSync(baselinePath, "utf8"))[section]}\nCurrent SHA-256: ${hash}\n\n**Maintainer action required:** Review the actual statutory change with legal counsel. Check chatbot/config.js, chatbot/scra-safety.js, chatbot/SCRA_LEGAL_REVIEW.md, and chatbot/multisource-baseline.json. Rerun the four Guard regression cases (chatbot/scra-baseline.test.js and the matching live cases via chatbot/multisource-baseline.js). Only after review, update the snapshot manually. Do not automatically change legal guidance or accept a new hash without review.`;
    const result = await apiFetch(endpoint, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }), signal: AbortSignal.timeout(20000),
    });
    if (!result.ok) throw new Error(`GitHub issue creation failed for § ${section} (HTTP ${result.status})`);
    console.error(`ALERT: GitHub issue created for § ${section}. ${url}`);
  }
}

export async function run() {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { changes, failures } = await compareStatutes(baseline);
  for (const { section, reason } of failures) console.error(`MONITOR WARNING: Could not check § ${section}: ${reason}`);
  for (const { section, url, hash } of changes) console.error(`STATUTE CHANGE: § ${section}: ${url} (current SHA-256 ${hash})`);
  try {
    await alertMaintainers(changes, process.env.GITHUB_TOKEN);
  } catch (error) {
    console.error(`ALERT DELIVERY FAILED: ${error.message}; review the STATUTE CHANGE warnings in workflow logs.`);
    return 1;
  }
  if (!changes.length && !failures.length) console.log("SCRA statutory text matches reviewed snapshot for §§ 3911, 3937, 3955.");
  return failures.length || changes.length ? 1 : 0;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  run().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`MONITOR WARNING: ${error.message}`);
    process.exitCode = 1;
  });
}