import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./dfas-pay-tables/manifest.json", import.meta.url), "utf8"));
const tableIds = [5, 6, 7, 8];
const money = value => {
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/.test(value)) throw new Error(`Invalid DFAS amount: ${value}`);
  return Math.round(Number(value.replaceAll(",", "")) * 100);
};
const cells = line => line.split("|").slice(1, -1).map(cell => cell.trim().replaceAll("**", ""));
const entries = new Map();
const tables = new Map();

for (const id of tableIds) {
  const meta = manifest.tables.find(item => item.id === id);
  if (!meta || meta.category !== "Drill Pay Rates" || meta.yearBasis !== "CY2026 effective Jan 1" ||
      !meta.sourceComplete || !/^https:\/\/www\.dfas\.mil\//i.test(meta.url)) {
    throw new Error(`Unverified DFAS drill table ${id}`);
  }
  const text = readFileSync(new URL(`./dfas-pay-tables/tables/${meta.tablePath.split("/").at(-1)}`, import.meta.url), "utf8");
  if (!text.includes(meta.url) || !/Effective January 1, 2026/i.test(text)) {
    throw new Error(`DFAS drill table ${id} has a missing source or effective date`);
  }
  const lines = text.split("\n");
  const notes = lines.filter(line => /^(?:\*\*Page updated|\*\*Note|Note:)/i.test(line)).map(line => line.trim());
  const table = { id, title: meta.title, url: meta.url, effectiveDate: "2026-01-01", notes };
  tables.set(id, table);
  let brackets = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\| \*\*Pay Grade\*\*/.test(lines[i])) {
      brackets = cells(lines[i]).slice(1).map(label => {
        const over = label.match(/^Over (\d+)/);
        if (label === "2 or less") return { label, over: -1 };
        if (!over) throw new Error(`Unexpected DFAS bracket: ${label}`);
        return { label: label.replace(/<br>/g, " "), over: Number(over[1]) };
      });
      continue;
    }
    const row = cells(lines[i]);
    const grade = row[0]?.match(/^(?:[EWO]-\d{1,2}E?)$/)?.[0];
    if (!grade || !brackets) continue;
    const one = cells(lines[++i]);
    const four = cells(lines[++i]);
    if (one[0] !== "1 Drill" || four[0] !== "4 Drills" ||
        row.length !== brackets.length + 1 || one.length !== row.length || four.length !== row.length) {
      throw new Error(`Malformed DFAS drill rows for ${grade}`);
    }
    const rows = entries.get(grade) || [];
    for (let j = 0; j < brackets.length; j++) {
      const values = [row[j + 1], one[j + 1], four[j + 1]];
      if (values.every(value => value === "")) continue; // Grade is not payable in this bracket.
      if (values.some(value => value === "")) throw new Error(`Incomplete DFAS drill row ${grade}`);
      const [monthlyCents, oneDrillCents, fourDrillsCents] = values.map(money);
      if (fourDrillsCents !== oneDrillCents * 4 ||
          Math.abs(oneDrillCents * 30 - monthlyCents) > 15) {
        throw new Error(`Inconsistent DFAS drill row ${grade} ${brackets[j].label}`);
      }
      if (rows.some(item => item.over === brackets[j].over)) throw new Error(`Duplicate DFAS bracket ${grade}`);
      rows.push({ ...brackets[j], oneDrillCents, fourDrillsCents, table });
    }
    entries.set(grade, rows);
  }
}

// The downloaded DFAS E-1 page repeats E-9 amounts in its last four columns.
// They also appear in the saved source page. Do not publish those suspect cells.
const e1 = entries.get("E-1");
const suspectE1 = e1.filter(row => row.over >= 26 &&
  row.oneDrillCents > entries.get("E-2").find(item => item.over === row.over)?.oneDrillCents);
if (suspectE1.length) {
  tables.get(8).notes.push("Saved DFAS source repeats E-9 amounts in E-1 high-service columns; those cells are withheld pending source correction.");
  entries.set("E-1", e1.filter(row => !suspectE1.includes(row)));
}
if (tables.size !== 4 || entries.size !== 24) throw new Error("Incomplete DFAS drill table import");
for (const rows of entries.values()) rows.sort((a, b) => a.over - b.over);

export function lookupDrillPay(grade, years) {
  if (!Number.isFinite(years) || years < 0 || years > 60) return null;
  const rows = entries.get(grade.toUpperCase().replace(/^([EWO])(?=\d)/, "$1-"));
  if (!rows) return null;
  const row = [...rows].reverse().find(item => years > item.over);
  if (!row) return null;
  // Do not fall back to a preceding row if the applicable E-1 cell is suspect.
  if (grade.toUpperCase().replace("-", "") === "E1" &&
      suspectE1.includes([...e1].reverse().find(item => years > item.over))) return null;
  return row;
}

export const drillPayTables = tables;

const gradeFrom = text => {
  const matches = [...text.matchAll(/\b([EWO])[- ]?0?(\d{1,2})(E)?\b/gi)].map(match => ({
    grade: `${match[1].toUpperCase()}-${Number(match[2])}${(match[3] || "").toUpperCase()}`,
    context: text.slice(Math.max(0, match.index - 30), match.index),
  }));
  const distinct = [...new Set(matches.map(match => match.grade))];
  if (distinct.length <= 1) return { grade: distinct[0] || null, ambiguous: false };
  const current = [...new Set(matches.filter(match =>
    /\b(?:now|currently|current(?:ly)?(?:\s+grade)?(?:\s+is)?|today|promoted to|now an?|am an?)\s*$/i.test(match.context)
  ).map(match => match.grade))];
  return current.length === 1 ? { grade: current[0], ambiguous: false } : { grade: null, ambiguous: true };
};
const yearsFrom = (text, pending) => {
  const over = text.match(/\b(?:over|more than)\s+(\d{1,2}(?:\.\d+)?)\s*(?:years?)?\b/i);
  if (over) return Number(over[1]) + 0.001;
  const match = text.match(/\b(\d{1,2}(?:\.\d+)?)\s*(?:\+|years?(?:\s+of\s+(?:creditable\s+)?service)?|yrs?|yos)\b/i);
  if (match) return Number(match[1]) + (match[0].includes("+") ? 0.001 : 0);
  if (pending && /^\s*\d{1,2}(?:\.\d+)?\s*$/.test(text)) return Number(text.trim());
  return null;
};

export function isDrillPayRateRequest(message) {
  return /\b(?:drill(?:ing)?|IDT|inactive duty training)\b/i.test(message) &&
    /\b(?:pay|paid|rate|amount|how much|earn|make|202\d)\b/i.test(message) &&
    !/\b(?:travel|commut|reimburs|BAH|BAS|points?|VA compensation)\b/i.test(message);
}

export function drillPayTurn(message, prior = null, now = new Date()) {
  const pending = prior && typeof prior === "object" && prior.active === true
    ? { grade: entries.has(prior.grade) ? prior.grade : null,
        years: Number.isFinite(prior.years) && prior.years >= 0 && prior.years <= 60 ? prior.years : null }
    : null;
  const request = isDrillPayRateRequest(message);
  if (!request && !pending) return null;
  if (pending && !request && (/[?]/.test(message) ||
      /\b(?:BAH|BAS|travel|reimbursement|retire|separation)\b/i.test(message))) return null;
  const yearsRequested = [...message.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  const year = yearsRequested[0] || now.getUTCFullYear();
  if (yearsRequested.some(value => value !== year) || year !== 2026) {
    return { text: `I only have verified 2026 DFAS drill-pay tables. I can't verify ${year} drill rates; check the [current DFAS drill-pay tables](${manifest.indexUrl}) for that year.`, sources: [], state: null };
  }
  const parsedGrade = gradeFrom(message);
  if (parsedGrade.ambiguous) {
    return { text: "You mentioned more than one pay grade. Which is your current pay grade for this drill-pay question (for example O-3 or O-3E)? I won't use a former grade to choose a rate.", sources: [], state: { active: true, grade: null, years: yearsFrom(message, false) ?? pending?.years ?? null } };
  }
  const grade = parsedGrade.grade || pending?.grade;
  const years = yearsFrom(message, Boolean(pending)) ?? pending?.years ?? null;
  if (grade && /^O-[123]$/.test(grade) && /\b(?:prior.enlisted|former enlisted|prior warrant)\b/i.test(message)) {
    return { text: `If you qualify for the prior-enlisted or prior-warrant officer pay table, please confirm your pay grade as ${grade}E; otherwise confirm ${grade}. I won't assume the special pay grade from prior service alone.`, sources: [], state: { active: true, grade: null, years } };
  }
  if (!grade || !entries.has(grade)) {
    return { text: "What is your pay grade (for example E-5, O-3, O-3E, or W-2)? The prior-enlisted/warrant commissioned officer table uses O-1E, O-2E, or O-3E when applicable.", sources: [], state: { active: true, grade: null, years } };
  }
  if (years === null) {
    return { text: `How many cumulative years of service do you have for the DFAS drill-pay table? I have your grade as ${grade}.`, sources: [], state: { active: true, grade, years: null } };
  }
  const row = lookupDrillPay(grade, years);
  if (!row) {
    return { text: `The saved 2026 DFAS table has no reliable drill-pay amount for ${grade} at ${years} years of service. Please confirm the correct grade and creditable service bracket with your unit finance office or the [DFAS drill-pay tables](${manifest.indexUrl}).`, sources: [], state: null };
  }
  const amount = cents => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const label = row.over === -1 ? "2 years or less" : row.label.toLowerCase();
  return {
    text: `For ${grade} with ${years} cumulative years of service (${label}), the DFAS table effective January 1, 2026 lists **${amount(row.oneDrillCents)} for 1 drill** and **${amount(row.fourDrillsCents)} for 4 drills**. Four drills are a common weekend, not a universal monthly paycheck; actual pay depends on drills performed and your circumstances. These are drill amounts, not monthly basic pay. [DFAS ${row.table.title} drill-pay table](${row.table.url}).`,
    sources: [row.table.url], state: null,
  };
}