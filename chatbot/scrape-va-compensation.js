/**
 * Extract VA's actual table cells, not flattened text or third-party COLA math.
 * NODE_USE_ENV_PROXY=1 node chatbot/scrape-va-compensation.js --write-snapshot
 * A refresh is explicit: review the changed snapshot before deploying it.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VA_COMPENSATION_URL = "https://www.va.gov/disability/compensation-rates/veteran-rates/";

function text(html) {
  const entities = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">" };
  return html.replace(/<[^>]+>/g, "").replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, key) => {
    if (key.startsWith("#")) return String.fromCodePoint(key[1].toLowerCase() === "x"
      ? parseInt(key.slice(2), 16) : Number(key.slice(1)));
    if (!(key in entities)) throw new Error(`Unsupported VA table entity ${entity}`);
    return entities[key];
  }).replace(/\s+/g, " ").trim();
}

function cents(value) {
  if (!/^\d{1,3}(?:,\d{3})*\.\d{2}$/.test(value)) throw new Error(`Invalid VA monetary cell: ${value}`);
  return Math.round(Number(value.replaceAll(",", "")) * 100);
}

export function parseVaCompensation(html, retrievedAt) {
  const year = Number(html.match(/Review (20\d{2}) Veterans disability compensation rates/)?.[1]);
  const dates = [...html.matchAll(/Effective December 1, (20\d{2})/g)].map(m => Number(m[1]));
  if (!year || !dates.length || dates.some(date => date !== year - 1)) {
    throw new Error("VA rate year and effective date are missing or inconsistent");
  }
  const tables = [...html.matchAll(/<va-table\b([^>]*)>([\s\S]*?)<\/va-table>/gi)];
  if (tables.length !== 9) throw new Error("VA table layout changed; review before refresh");
  const basic = {}, additions = {}, smallRatings = {};
  for (const [tableIndex, table] of tables.entries()) {
    const title = text(table[1].match(/table-title="([^"]*)"/)?.[1] || "");
    const rows = [...table[2].matchAll(/<va-table-row\b[^>]*>([\s\S]*?)<\/va-table-row>/gi)]
      .map(row => [...row[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(cell => text(cell[1])));
    const headers = rows.shift();
    if (tableIndex === 0) {
      if (headers?.[0] !== "Disability rating" || rows.length !== 2) throw new Error("Invalid 10/20% table");
      for (const row of rows) {
        if (!/^(?:10|20)%$/.test(row[0]) || row.length !== 2) throw new Error("Invalid 10/20% rate row");
        smallRatings[parseInt(row[0])] = cents(row[1]);
      }
      continue;
    }
    const ratings = headers?.slice(1).map(label => Number(label.match(/^(\d+)% disability rating/)?.[1]));
    if (headers?.[0] !== "Dependent status" || ratings?.length !== 4 ||
        ratings.some(r => ![30, 40, 50, 60, 70, 80, 90, 100].includes(r))) {
      throw new Error("Invalid rating column labels");
    }
    for (const row of rows) {
      if (row.length !== ratings.length + 1) throw new Error("Incomplete VA rate row");
      const label = row[0];
      let target;
      if (/^Added amounts/.test(title)) {
        const key = /under age 18/.test(label) ? "childUnder18" :
          /over age 18/.test(label) ? "schoolChildOver18" :
          /spouse.*Aid and Attendance/i.test(label) ? "spouseAidAttendance" : null;
        if (!key) throw new Error(`Unknown added-amount row: ${label}`);
        target = additions[key] ||= { label, amounts: {} };
      } else if (/^Basic monthly rates/.test(title)) {
        const category = label.replace(/\([^)]*\)/g, "").trim();
        const spouse = /\bspouse\b/.test(category);
        const parents = /\b2 parents\b/.test(category) ? 2 : /\b1 parent\b/.test(category) ? 1 : 0;
        const child = /\bchild\b/.test(category);
        const key = `${Number(spouse)}-${parents}-${Number(child)}`;
        target = basic[key] ||= { label, spouse, parents, includesOneChild: child, amounts: {} };
      } else throw new Error("Unexpected VA table title");
      ratings.forEach((rating, i) => {
        const amount = cents(row[i + 1]);
        if (target.amounts[rating] !== undefined && target.amounts[rating] !== amount) {
          throw new Error("Contradictory duplicate VA amount");
        }
        target.amounts[rating] = amount;
      });
    }
  }
  if (Object.keys(basic).length !== 12 || Object.keys(additions).length !== 3 ||
      Object.keys(smallRatings).length !== 2 ||
      [...Object.values(basic), ...Object.values(additions)].some(row => Object.keys(row.amounts).length !== 8)) {
    throw new Error("VA compensation table is incomplete");
  }
  const updated = text(html).match(/Last updated:\s*([A-Za-z]+ \d{1,2}, 20\d{2})/)?.[1] || null;
  return {
    sourceUrl: VA_COMPENSATION_URL,
    title: "VA Veterans disability compensation rates",
    rateYear: year,
    effectiveDate: `${year - 1}-12-01`,
    // This is a safety stop for quoting a saved annual table as current, not
    // a claim that the next year's rates have been enacted or published.
    currentUseThrough: `${year}-11-30`,
    retrievedAt, sourceUpdated: updated,
    sourceSha256: createHash("sha256").update(html).digest("hex"),
    smallRatings, basic, additions,
  };
}

async function main() {
  const response = await fetch(VA_COMPENSATION_URL, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html") ||
      response.url !== VA_COMPENSATION_URL) throw new Error("Could not verify the VA rate-page response");
  const snapshot = parseVaCompensation(await response.text(), new Date().toISOString());
  if (process.argv.includes("--write-snapshot")) {
    writeFileSync(new URL("./va-compensation-rates.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`Saved official VA ${snapshot.rateYear} rates: 122 distinct monetary cells, including added amounts.`);
  } else console.log(JSON.stringify(snapshot, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
