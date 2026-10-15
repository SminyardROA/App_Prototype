import { createHash } from "node:crypto";
import { cfrPart, canonicalSourceIdentity } from "./source-provenance.js";
import { extractionIssues } from "./audit-source-quality.js";

export function matchesTarget(document, target) {
  if (!document || !target) return false;
  if (target.part !== undefined && cfrPart(document) !== target.part) return false;
  if (target.article && canonicalSourceIdentity(document.url) !== `roa-law-review-${target.article}`) return false;
  const text = String(document.text || "").normalize("NFKC").replace(/\s+/g, " ");
  if (target.section) {
    const escaped = target.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (document.section) {
      // A cross-reference inside another section is not the target section.
      if (!new RegExp(`^(?:§\\s*)?${escaped}(?:$|\\()`, "i").test(String(document.section))) return false;
    } else if (!new RegExp(`(?:^|\\n)\\s*(?:38 CFR\\s+)?§\\s*${escaped}(?![\\d.a-z])`, "i")
      .test(String(document.text || "").normalize("NFKC"))) return false;
  }
  return target.patterns.every(pattern => new RegExp(pattern, "i").test(text));
}

export function evidenceReference(document, target, id = null) {
  const text = String(document.text || "");
  const match = new RegExp(target.patterns[0], "i").exec(text);
  const start = Math.max(0, (match?.index || 0) - 80);
  return {
    id, title: document.title || "", url: document.url || "",
    section: document.section || null, page: document.pageStart || null,
    date: document.documentDate || null,
    // Public member-corpus evidence only; no visitor text or vector values.
    excerpt: text.slice(start, start + 450),
    textHash: createHash("sha256").update(text).digest("hex"),
    issues: extractionIssues(text),
  };
}

export function createInventory(targets) {
  const evidence = Object.fromEntries(targets.map(target => [target.id, { count: 0, examples: [] }]));
  return {
    evidence,
    add(document, id) {
      for (const target of targets) {
        if (!matchesTarget(document, target)) continue;
        const entry = evidence[target.id];
        entry.count++;
        if (entry.examples.length < 3) entry.examples.push(evidenceReference(document, target, id));
      }
    },
  };
}

export function assessRetrieval(item, targets, inventory, kb, rawDocuments = [], complete = true) {
  const selected = kb.sourceDocuments || [];
  const coverage = item.targets.map(id => {
    const target = targets.find(target => target.id === id);
    if (!target) throw new Error(`Unknown retrieval target: ${id}`);
    const selectedHits = selected.filter(document => matchesTarget(document, target));
    return {
      target: id, inventoryCount: inventory[id]?.count || 0,
      inventoryEvidence: inventory[id]?.examples || [],
      selectedEvidence: selectedHits.slice(0, 3).map(document => evidenceReference(document, target)),
      rawQueryHit: rawDocuments.some(document => matchesTarget(document, target)),
    };
  });
  let status;
  if (!complete) status = "inventory_incomplete";
  else if (kb.status === "unavailable") status = "search_unavailable";
  else if (coverage.some(entry => !entry.inventoryCount)) {
    status = coverage.every(entry => entry.selectedEvidence.length) ? "inventory_drift" : "baseline_gap";
  } else if (coverage.every(entry => entry.selectedEvidence.length)) status = "retrieved";
  else if (coverage.some(entry => entry.selectedEvidence.length)) status = "partial_evidence";
  else if (coverage.every(entry => entry.rawQueryHit)) status = "filtered_or_context_limit";
  else status = "search_miss";
  return {
    id: item.id, question: item.question, history: item.history, kind: item.kind,
    caution: item.caution || null, status, coverage,
    selectedSourceCount: selected.length,
    selectedSources: selected.map(document => ({
      title: document.title, url: document.url, section: document.section || null,
      date: document.documentDate || null,
    })),
  };
}

const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const link = url => /^https:\/\//i.test(url || "")
  ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>` : escape(url);

export function renderRetrievalReport(report) {
  const counts = Object.entries(report.summary).map(([key, count]) => `${escape(key)}: <strong>${count}</strong>`).join(" · ");
  const knownMisses = report.results.filter(result =>
    ["search_miss", "filtered_or_context_limit", "partial_evidence"].includes(result.status)).length;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VA retrieval baseline</title><style>body{font:16px/1.5 system-ui;margin:0;background:#f4f6fa;color:#17263b}main{max-width:1100px;margin:auto;padding:30px}h1{color:#092d61}article{background:white;border:1px solid #cdd5df;border-radius:8px;padding:18px;margin:14px 0}p{margin:8px 0}a{overflow-wrap:anywhere;color:#164b8d}pre,blockquote{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f8;padding:12px;font-size:14px}.status{font-weight:700}small{color:#415469}details{margin:10px 0}summary{cursor:pointer}</style><main>
<h1>VA retrieval baseline</h1><p>Checked: ${escape(report.createdAt)} · ${report.results.length} synthetic questions · ${report.inventory.records} member-corpus records.</p>
<article><h2>Summary</h2><p><strong>${report.summary.retrieved || 0}</strong> questions retrieved every expected passage.
<strong>${knownMisses}</strong> missed at least one independently confirmed indexed passage.
<strong>${report.summary.baseline_gap || 0}</strong> could not confirm the expected baseline anchor.</p>
<p>${counts}</p><h3>Priorities</h3><ol><li>${knownMisses ? "Keep applicable primary CFR passages when they appear in search responses but are lost during filtering, ranking, or context selection." : "Keep the successful exact-section and diagnostic-code recovery covered by regression tests."}</li>
<li>${knownMisses ? "Add reliable exact-section and diagnostic-code recovery for expected passages that semantic searches miss." : "All independently confirmed expected anchors reached selected context in this run; this does not certify final-answer accuracy."}</li>
<li>Review unconfirmed anchors against the source inventory before adding documents or telling a visitor a resource is absent.</li>
<li>Rerun this baseline after fixes and ingestion; evaluate final-answer faithfulness separately.</li></ol></article>
<article><strong>Scope and limits</strong><p>This read-only evaluation tests whether expected regulatory or Law Review passages are retrieved. It does not generate or verify benefit answers, evaluate refusals, establish eligibility, or prove that an entire table is complete. A missing expected primary passage does not mean all selected sources were irrelevant or that the question was unanswerable. No member conversations were used. The source anchors need independent VA-qualified review before use as a legal-answer gold standard.</p>
<p>A baseline_gap means the expected anchor was not confirmed in the inventory—not that the library definitively lacks the resource. filtered_or_context_limit means the source appeared in production search results but was absent from the selected context. search_miss means it was independently confirmed in the index but not selected or found in captured production queries.</p>
<p>Namespace: default/member-approved only. Inventory complete: ${escape(report.inventory.complete)}. Counts were checked before and after the scan; this is not a transactional index snapshot, and concurrent ingestion can change evidence. No private staff namespaces queried.</p></article>
${report.results.map(result => `<article><h2>${escape(result.id)}</h2><p class="status">${escape(result.status)}</p><p>${escape(result.question)}</p>
${result.history.length ? `<p><small>Prior synthetic context: ${escape(result.history.map(turn => turn.content).join(" / "))}</small></p>` : ""}
${result.caution ? `<p><strong>Caution:</strong> ${escape(result.caution)}</p>` : ""}
${result.coverage.map(entry => `<details${result.status !== "retrieved" ? " open" : ""}><summary>${escape(entry.target)} — ${entry.inventoryCount} matching indexed passages; ${entry.selectedEvidence.length} selected examples; raw search hit: ${entry.rawQueryHit}</summary>
<h3>Independent inventory evidence</h3>${entry.inventoryEvidence.map(source => `<p>${escape(source.title)} · section ${escape(source.section)} · date ${escape(source.date)}<br>${link(source.url)}</p><blockquote>${escape(source.excerpt)}</blockquote><small>Record: ${escape(source.id)} · extraction flags: ${escape(source.issues.join(", ") || "none")}</small>`).join("") || "<p>No matching anchor confirmed.</p>"}
<h3>Selected evidence</h3>${entry.selectedEvidence.map(source => `<p>${link(source.url)} · section ${escape(source.section)}</p><blockquote>${escape(source.excerpt)}</blockquote>`).join("") || "<p>No expected passage in selected context.</p>"}</details>`).join("")}
<details><summary>All selected sources (${result.selectedSourceCount})</summary>${result.selectedSources.map(source => `<p>${escape(source.title)} · section ${escape(source.section)}<br>${link(source.url)}</p>`).join("")}</details></article>`).join("")}</main></html>`;
}
