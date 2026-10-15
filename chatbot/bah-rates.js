import fs from "node:fs";

const data = JSON.parse(fs.readFileSync(new URL("./dfas-pay-tables/bah-2026.json", import.meta.url), "utf8"));
export const BAH_LOOKUP_URL = data.officialLookup;
const officialTx270 = data.tx270Notice;
const NON_LOCALITY_URL = "https://www.travel.dod.mil/Portals/119/Documents/BAH/PDF_Non-Locality-BAH-Rates/2026-Non-Locality-BAH-Rates.pdf";
const states = [...new Set(Object.keys(data.areas).map(code => code.slice(0, 2)))]
  .filter(code => code !== "ZZ");
const stateNames = Object.fromEntries([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
]);
const grades = new Set(Object.keys(data.areas.TX270.with));

export function sanitizeBahLookupState(input) {
  if (!input || typeof input !== "object") return null;
  const area = typeof input.area === "string" && data.areas[input.area] ? input.area : null;
  const state = area ? area.slice(0, 2) : states.includes(input.state) ? input.state : null;
  if (!state || state === "ZZ") return null;
  return {
    state,
    area,
    grade: grades.has(input.grade) ? input.grade : null,
    dependents: typeof input.dependents === "boolean" ? input.dependents : null,
    preTemporary: input.preTemporary === true,
  };
}

function parseGrade(text) {
  const match = String(text).toUpperCase().match(/\b([EWO])[- ]?0?(\d{1,2})(E)?\b/);
  if (!match) return null;
  const number = Number(match[2]);
  const grade = `${match[1]}${String(match[1] === "O" && number >= 7 ? 7 : number).padStart(2, "0")}${match[3] || ""}`;
  return grades.has(grade) ? grade : null;
}

function parseDependents(text, awaiting = false) {
  if (/\b(?:without dependents?|no dependents?|no spouse or children)\b/i.test(text)) return false;
  if (/\b(?:with dependents?|have dependents?|with a dependent)\b/i.test(text)) return true;
  if (awaiting && /^(?:yes|y|a)\.?$/i.test(text.trim())) return true;
  if (awaiting && /^(?:no|n|b)\.?$/i.test(text.trim())) return false;
  return null;
}

function parseState(text) {
  for (const code of states) {
    if (new RegExp(`\\b${code}\\d{3}\\b`, "i").test(text)) return code;
  }
  const byName = states.find(code => new RegExp(`\\b${stateNames[code]}\\b`, "i").test(text));
  if (byName) return byName;
  // Only treat a two-letter abbreviation as a state when it is capitalized;
  // lower-case "in", "or", and "me" occur often in ordinary questions.
  return states.find(code => new RegExp(`\\b${code}\\b`).test(text)) || null;
}

function areasForState(state) {
  return Object.entries(data.areas)
    .filter(([code]) => code.startsWith(state) && state !== "ZZ")
    .sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]));
}

function parseArea(text, state) {
  const areas = state ? areasForState(state) :
    Object.entries(data.areas).filter(([code]) => !code.startsWith("ZZ"));
  const code = text.toUpperCase().match(/\b[A-Z]{2}\d{3}\b/)?.[0];
  if (code && data.areas[code] && (!state || code.startsWith(state))) return code;
  if (state && /^\s*\d{1,2}\s*$/.test(text)) {
    return areas[Number(text.trim()) - 1]?.[0] || null;
  }
  const matches = areas.filter(([, area]) => {
    const name = area.name.split(",")[0].trim();
    const alias = name.split("/")[0].trim();
    return [name, alias].some(candidate => candidate.length >= 4 &&
      new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  });
  return matches.length === 1 ? matches[0][0] : null;
}

export function isBahRateRequest(message) {
  return /\b(?:BAH|basic allowance for housing|housing allowance)\b/i.test(message) &&
    (/\b(?:rate|amount|how much|monthly|month|table|202\d|per year)\b/i.test(message) ||
      (!/\b(?:eligib|qualif|entitl)/i.test(message) &&
        /\b(?:for|in)\b/i.test(message) &&
        Boolean(parseState(message) || parseGrade(message) || parseArea(message, null))));
}

export function bahRateTurn(message, prior = null, now = new Date()) {
  const pending = sanitizeBahLookupState(prior);
  if (!isBahRateRequest(message) && !pending) return null;
  if (pending && !isBahRateRequest(message) && /\b(?:BAS|TRICARE|FSA|adoption|drill pay)\b|[?]/i.test(message)) return null;
  const years = [...String(message).matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  if (years.some(year => year !== data.year) || (!years.length && now.getUTCFullYear() !== data.year)) {
    return { text: `I only have a verified ${data.year} locality BAH snapshot. For another year, use the [official BAH rate lookup](${BAH_LOOKUP_URL}).`, sources: [], state: null };
  }
  if (/\b(?:BAH[-\s]?(?:RC|T)|reserve component BAH|non-locality BAH)\b/i.test(message)) {
    return { text: `BAH-RC/T is a **non-locality** allowance; the state-based workbook is not the right table. See the [official 2026 non-locality BAH rates](${NON_LOCALITY_URL}) and confirm which housing allowance applies to your orders with unit finance.`, sources: [NON_LOCALITY_URL], state: null };
  }
  if (/\b(?:IDT|inactive duty training|drill(?:ing)?|state active duty)\b/i.test(message)) {
    return { text: `Federal locality BAH does not generally apply to IDT/drill or state active duty. I won't use an active-duty BAH table to imply you receive it; confirm your duty status with your unit finance office.`, sources: [], state: null };
  }
  if (/\b(?:\d{1,2}[- ]day|30 days? or fewer|short orders?)\b/i.test(message)) {
    return { text: `For orders of 30 days or fewer, I first need to know whether the orders support a contingency operation. Non-contingency orders generally use BAH-RC/T, not this locality table. Check your orders and [2026 non-locality rates](${NON_LOCALITY_URL}), or ask your unit finance office.`, sources: [NON_LOCALITY_URL], state: null };
  }
  if (/\b\d{5}(?:-\d{4})?\b/.test(message) && !parseArea(message, null)) {
    return { text: `This table lists military housing areas, not ZIP codes. Enter your ZIP code in the [official BAH rate lookup](${BAH_LOOKUP_URL}) to identify the correct area and rate.`, sources: [BAH_LOOKUP_URL], state: null };
  }
  const requestedState = parseState(message) || pending?.state || null;
  const area = parseArea(message, requestedState) ||
    (requestedState === pending?.state ? pending.area : null);
  const state = requestedState || (area ? area.slice(0, 2) : null);
  const grade = parseGrade(message) || pending?.grade || null;
  const dependents = parseDependents(message, pending?.dependents === null && !!pending?.area && !!pending?.grade);
  const status = dependents === null ? pending?.dependents ?? null : dependents;
  const preTemporary = /\b(?:January|February|March|April)\s+(?:\d{1,2},?\s+)?2026\b/i.test(message) ||
    /\bMay\s+(?:[1-9]|1[0-5]),?\s*2026\b/i.test(message) ||
    /\bMay\s+2026\b/i.test(message) ||
    pending?.preTemporary === true;
  const next = { state, area, grade, dependents: status, preTemporary };

  if (!state) {
    return {
      text: `Which state contains the applicable BAH locality? This is generally the permanent duty station, but certain Reserve orders use a different location. Tell me the state, or use the [official ZIP-code BAH lookup](${BAH_LOOKUP_URL}).`,
      sources: [BAH_LOOKUP_URL], state: null,
    };
  }
  if (!area) {
    const choices = areasForState(state);
    if (!choices.length) {
      return { text: `I don't have a listed housing area for that state. Use the [official ZIP-code BAH lookup](${BAH_LOOKUP_URL}).`, sources: [BAH_LOOKUP_URL], state: null };
    }
    return {
      text: `The ${data.year} workbook lists these housing areas in ${stateNames[state]}:\n\n${choices.map(([code, item], i) => `${i + 1}. ${item.name} (${code})`).join("\n")}\n\nWhich area applies? Reply with its number or code. If you only know a ZIP code, use the [official BAH rate lookup](${BAH_LOOKUP_URL}).`,
      sources: [BAH_LOOKUP_URL], state: next,
    };
  }
  if (!grade) {
    return { text: `What is your pay grade (for example, E-5 or O-2E)? I need it to find the ${data.areas[area].name} table amount.`, sources: [], state: next };
  }
  if (status === null) {
    return { text: `Do you have dependents? The ${data.year} BAH table has separate with-dependents and without-dependents rates.`, sources: [], state: next };
  }
  if (area === "TX270" && (now.getUTCFullYear() !== 2026 || now.toISOString().slice(0, 10) < data.tx270Effective ||
      preTemporary)) {
    return { text: `The uploaded TX270 table includes a temporary increase effective May 16–December 31, 2026. I can't use it for an earlier date. Check the [official BAH rate lookup](${BAH_LOOKUP_URL}).`, sources: [BAH_LOOKUP_URL], state: null };
  }
  const amount = data.areas[area][status ? "with" : "without"][grade];
  const unit = area === "TX270" ? " This TX270 temporary rate applies May 16–December 31, 2026; it is not a January–May 15 rate." : "";
  const citation = area === "TX270" ? ` See the [official TX270 notice](${officialTx270}) and [BAH lookup](${BAH_LOOKUP_URL}).` :
    ` Verify your location in the [official BAH rate lookup](${BAH_LOOKUP_URL}).`;
  return {
    text: `The ${data.year} locality BAH **table amount** for ${data.areas[area].name} (${area}), pay grade ${grade.replace(/^([EWO])0/, "$1")}, ${status ? "with" : "without"} dependents is **$${amount.toLocaleString("en-US")}/month**.${unit}${citation} This is not a determination that locality BAH applies to your orders; short non-contingency Reserve orders may instead use BAH-RC, which is not in this workbook. Confirm your duty status, applicable location, and entitlement with your unit finance office.`,
    sources: area === "TX270" ? [officialTx270, BAH_LOOKUP_URL] : [BAH_LOOKUP_URL],
    state: null,
  };
}