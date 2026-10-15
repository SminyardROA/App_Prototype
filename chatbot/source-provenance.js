import fs from "node:fs";

const sources = JSON.parse(fs.readFileSync(new URL("./verified-sources.json", import.meta.url), "utf8"));
const exceptions = JSON.parse(fs.readFileSync(new URL("./source-quality-exceptions.json", import.meta.url), "utf8"));
const byFilename = new Map(sources.filter(s => s.originalFilename).map(s => [s.originalFilename, s]));

// Only exact, verified identities are mapped. A plausible filename is not
// permission to manufacture a public citation or regulatory version.
export function verifiedUploadedSource(value) {
  return byFilename.get(String(value || "").replace(/^docs\//, ""));
}

export function sourceException(url) {
  return exceptions.find(source => source.url === url);
}

export function cfrPart(document) {
  try {
    const url = new URL(document?.url);
    if (!/^(?:www\.)?ecfr\.gov$/i.test(url.hostname) || url.protocol !== "https:") return null;
    const pathPart = url.pathname.match(/^\/(?:current|on\/\d{4}-\d{2}-\d{2})\/title-38\/(?:chapter-I\/)?part-(\d+)(?:\/|$)/);
    if (pathPart) return Number(pathPart[1]);
    if (/^\/api\/versioner\/v1\/full\/\d{4}-\d{2}-\d{2}\/title-38\.xml$/.test(url.pathname) &&
        /^\d+$/.test(url.searchParams.get("part") || "")) return Number(url.searchParams.get("part"));
  } catch {}
  return null;
}

export function sourceQualityRank(document) {
  if (document.legalStatus === "proposal-discussion") return 0;
  if (cfrPart(document) !== null || /^https:\/\/(?:www\.)?va\.gov\//i.test(document.url || "")) return 3;
  if (document.sourceKind === "official-regulation") return 3;
  return 1;
}

export function canonicalSourceIdentity(url) {
  try {
    const parsed = new URL(url);
    const article = parsed.pathname.match(/\/(?:lr)?(\d{4,5})(?:[-_a-z][^/]*)?\.pdf$/i);
    if (/^(?:assets\.|www\.)?roa\.org$/i.test(parsed.hostname) && article) return `roa-law-review-${article[1]}`;
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch { return String(url || "").split("#")[0].trim().toLowerCase(); }
}

export function sourceContext(document, index) {
  const location = [
    document.section ? `Section: ${document.section}${document.sectionTitle ? ` (${document.sectionTitle})` : ""}.` : "",
    document.pageStart !== undefined ? `Indexed pages: ${document.pageStart}${document.pageEnd !== undefined ? `–${document.pageEnd}` : ""}.` : "",
    document.sourceReference ? `Indexed record reference: ${document.sourceReference}.` : "",
    document.originalSource ? `Original uploaded reference: ${document.originalSource}.` : "",
  ].filter(Boolean).join("\n");
  const proposal = document.legalStatus === "proposal-discussion" ||
    /\b(?:proposed (?:rule|regulation|legislation|updates?)|legislative proposal|bill would)\b/i.test(document.text);
  return `[Source ${index + 1}: ${document.title ? `${document.title} — ` : ""}${document.url || "No verified public URL"}]\n` +
    (document.documentDate
      ? `Indexed document date: ${document.documentDate} (not a live-current verification).\n`
      : "Document date unknown; ingestion time is not a publication or effective date.\n") +
    (document.sourceKind === "roa-analysis" ? "Dated ROA analysis, not an enacted rule or live-current verification.\n" : "") +
    (document.verificationNote ? `SOURCE VERIFICATION LIMIT: ${document.verificationNote}\n` : "") +
    (proposal ? "PROPOSAL DISCUSSION: This passage does not establish that a proposal was enacted. Verify operative rules separately.\n" : "") +
    (location ? `${location}\n` : "") + document.text;
}
