import express from "express";
import { isScraQuestion, finalizeScraAnswer, SCRA_LEASE_URL, SCRA_INTEREST_URL, SCRA_SERVICE_URL } from "./scra-safety.js";
import Anthropic from "@anthropic-ai/sdk";
import { Pinecone } from "@pinecone-database/pinecone";
import { containsObviousPersonalData } from "./personal-data.js";
import {
  redactPII, detectCrisis, isHarmToOthers, REDACTION_NOTICE,
  CRISIS_MESSAGE, CRISIS_OTHERS_MESSAGE, INFORMATIONAL_FOOTER,
} from "./safety.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { config } from "./config.js";
import { ensureResourceReferrals } from "./resource-referrals.js";
import { KNOWLEDGE_INDEX, KNOWLEDGE_MODEL, assertKnowledgeIndex } from "./knowledge-index.js";
import { PINNED_SECTIONS, dd214PathwayChunkIds, dodFmrBahRequiredChunkIds, verifyPinnedChunks } from "./pinned-chunks.js";
import { buildRetrievalQuery } from "./retrieval-query.js";
import { queryKnowledgeIndex } from "./knowledge-search.js";
import { vaCfrPlans, recoverCfrMatches } from "./va-cfr-retrieval.js";
import {
  isTrainingServiceResearch, TRAINING_STATUTE_FILTER, selectTrainingAuthority,
  trainingAuthorityInstruction, normalizeTrainingCitationLists,
} from "./training-authority.js";
import { isSusanLukasResearchQuestion, SUSAN_LUKAS_DOCUMENT } from "./legislation-topics.js";
import { isGeneralVaOpening, VA_OPENING_REPLY } from "./va-opening.js";
import { verifiedUploadedSource, sourceQualityRank, sourceContext, canonicalSourceIdentity, sourceException } from "./source-provenance.js";
import { sourcePackAuthentication, sourcePackHandler } from "./source-pack.js";
import { DD214_AWARENESS_QUESTION, resolveDd214State, removeRepeatedDd214Awareness, volunteeredDd214Awareness } from "./dd214-awareness.js";
import { currentBasAnswer, currentIdtTravelCapAnswer, hasCurrentYearRateEvidence, isCurrentBasRateQuestion, isCurrentIdtTravelCapQuestion, isCurrentPayRateQuestion } from "./current-pay-rates.js";
import { drillPayTurn } from "./drill-pay-rates.js";
import { vaCompensationTurn } from "./va-compensation.js";
import { cachedSystemBlocks } from "./prompt-cache.js";
import { bahRateTurn, sanitizeBahLookupState } from "./bah-rates.js";
import { officialAllowanceAnswer } from "./official-allowances.js";
import {
  isVaDisabilityQuestion, relevantVaDisabilityDocuments, resolveVaDisabilityQuestion,
  focusedVaSearchQuery, validateVaCitationLinks, resolveVaCitationMarkers,
} from "./va-disability.js";
import {
  isShoulderRatingQuestion, isOfficialShoulderSchedule, preferShoulderSchedule, shoulderCriteriaAnswer,
  isShoulderMotionCriteriaQuestion,
} from "./shoulder-ratings.js";
import {
  isInjuryResearchQuestion, isCfrTitle38Source, preferInjuryRegulations, injuryResearchClarification,
  isSafeInjuryClarification, injuryContextSearches,
  needsInjuryResearchIntake, limbLossOverview,
} from "./injury-retrieval.js";
import {
  VETERAN_DEFINITION_URL, isVeteranDefinitionQuestion, isVeteranDefinitionMatch,
  contextualVeteranQuestion, veteranBenefitClarification, veteranGuidanceInstruction,
} from "./veteran-definition.js";
import { formatServiceCharacterizationQuestions } from "./veteran-intake.js";
import {
  TRANSITION_CLOSING,
  TRANSITION_QUESTIONS,
  newTransitionIntake,
  advanceTransitionIntake,
  parseTransitionAnswer,
  transitionGuidance,
  rememberTransitionAnswers,
} from "./transition-intake.js";
import {
  TRAINING_CONFIRMATION,
  TRAINING_PAY_GRADE,
  PAY_DEPENDENTS_QUESTION,
  PAY_YEARS_QUESTION,
  PAY_OTHER_CIRCUMSTANCES_QUESTION,
  letteredPayQuestion,
  selectedPayOption,
  explicitTrainingType,
  isPayDutyStatusQuestion,
  isTrainingChoice,
  lastPayQuestion,
  parseServiceYears,
  trainingType,
  sanitizePayFacts,
  rememberPayFacts,
  nextMissingPayQuestion,
} from "./pay-training-intake.js";

// --- Setup ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const dodFmrVolume7aSource = "docs/Volume_07a.pdf";
const dodFmrVolume7aUrl = "https://comptroller.defense.gov/portals/45/documents/fmr/volume_07a.pdf";
const dodi133601Source = "docs/133601p.pdf";
const dodi133601Url = "https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodi/133601p.pdf";
const dodi121506Url = "https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodi/121506p.pdf";
const jtrPublicUrl = "https://www.travel.dod.mil/Travel-Transportation-Rates/Per-Diem/JTR/";
const scraLeaseStatuteUrl = SCRA_LEASE_URL;
const scraInterestStatuteUrl = SCRA_INTEREST_URL;

function normalizeSourceUrl(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").trim().split("#", 1)[0].replace(/\/$/, "").toLowerCase();
  }
}

function publicSourceUrl(url) {
  const value = String(url || "").trim();
  if (/^(?:\.\/)?jtr\.pdf$/i.test(value) || /(?:^|[/])jtr\.pdf(?:#|$)/i.test(value)) {
    return jtrPublicUrl;
  }
  const verified = verifiedUploadedSource(value);
  if (verified) return verified.url;
  return value;
}

function sourceDocument(match) {
  const original = match?.metadata || {};
  const verified = verifiedUploadedSource(original.source || original.filename);
  // Legacy records can use the verified identity/date, but retain their own
  // text/location. Do not transfer XML sections onto old PDF page numbers.
  const metadata = { ...(verified || {}), ...original,
    ...(verified ? { url: verified.url, title: verified.title, documentDate: verified.documentDate } : {}),
    ...(verified?.legalStatus === "proposal-discussion" ? { legalStatus: verified.legalStatus } : {}) };
  const first = keys => keys.map(key => metadata[key]).find(value => typeof value === "string" && value.trim()) || "";
  const exception = sourceException(metadata.url);
  return {
    text: first(["text", "chunk_text", "content"]),
    url: publicSourceUrl(isDodFmrVolume7aMatch(match) ? dodFmrVolume7aUrl
      : isDodi133601Match(match) ? dodi133601Url : first(["url", "source_url", "source", "filename"])),
    title: isDodFmrVolume7aMatch(match) ? "DoD Financial Management Regulation Volume 7A"
      : isDodi133601Match(match) ? "DoD Instruction 1336.01, Certificate of Uniformed Service"
      : first(["title", "source_title", "filename", "source"]),
    ...(first(["documentDate", "publication_date", "published_date"])
      ? { documentDate: first(["documentDate", "publication_date", "published_date"]) } : {}),
    ...(metadata.pageStart !== undefined ? { pageStart: metadata.pageStart } : {}),
    ...(metadata.pageEnd !== undefined ? { pageEnd: metadata.pageEnd } : {}),
    ...Object.fromEntries(["section", "sectionTitle", "sourceKind", "currency", "legalStatus",
      "originalSource", "originalFilename", "sourceSha256"].filter(key => metadata[key])
      .map(key => [key, metadata[key]])),
    sourceReference: match?.id || "",
    ...(exception ? { verificationStatus: exception.verificationStatus, verificationNote: exception.note } : {}),
  };
}

function sourceDocumentKey(match) {
  if (match?.metadata?.documentIdentity) return match.metadata.documentIdentity;
  const url = sourceDocument(match).url;
  return canonicalSourceIdentity(url || match?.id);
}

// A URL alone cannot identify the topic of numeric Law Center PDF uploads.
// Require topic-specific text before treating a chunk as supporting a claim.
const authorityFamilies = {
  userraReemployment: doc => /\buserra\b|uniformed services employment and reemployment rights/i.test(`${doc.title} ${doc.text}`) &&
    /\breemploy(?:ment|ed)?\b|return to (?:civilian )?work/i.test(doc.text),
  scraLease: doc => /\bscra\b|servicemembers civil relief|50 u\.?s\.?c\.? §? ?3955/i.test(`${doc.title} ${doc.text}`) &&
    /\b(?:residential )?lease\b/i.test(doc.text) && /\bterminat(?:e[ds]?|ion|ing)\b/i.test(doc.text),
};

function requiredAuthorityFamilies(question) {
  const q = String(question || "");
  return /\buserra\b/i.test(q) && /\breemploy|civilian (?:job|employer|position)/i.test(q) &&
    /\bscra\b/i.test(q) && /\blease\b/i.test(q)
    ? ["userraReemployment", "scraLease"] : [];
}

function sourceAttribution(question, sourceDocuments = [], answer = "") {
  const q = String(question || "").toLowerCase();
  const docs = sourceDocuments
    .map(doc => ({ ...doc, url: publicSourceUrl(doc.url) }))
    .filter(doc => /^https?:\/\//i.test(doc.url || "") && doc.text);
  const lines = [];
  const isTravelPay = /\b(?:idt|drill|pay|bah)\b/i.test(q) &&
    /\b(?:travel|lodging|per diem|reimburse|reimbursement)\b/i.test(q);
  if (isTravelPay) {
    const fmr = docs.find(doc => /volume[_ -]?0?7a|financial management regulation/i.test(`${doc.title} ${doc.url}`));
    const jtr = docs.find(doc => /\bjtr\b|joint travel regulations?|travel\.dod\.mil/i.test(`${doc.title} ${doc.url}`));
    if (fmr && jtr && normalizeSourceUrl(fmr.url) !== normalizeSourceUrl(jtr.url)) {
      lines.push(`For the pay entitlement, see [DoD Financial Management Regulation Volume 7A](${fmr.url}); for travel or lodging, see [Joint Travel Regulations](${jtr.url}).`);
    }
  }
  if (requiredAuthorityFamilies(question).length === 2 &&
      /\breemploy|civilian (?:job|position)/i.test(answer) && /\blease\b/i.test(answer)) {
    const job = docs.find(authorityFamilies.userraReemployment);
    const lease = docs.find(doc => authorityFamilies.scraLease(doc) &&
      normalizeSourceUrl(doc.url) !== normalizeSourceUrl(job?.url));
    if (job && lease) {
      lines.push(`For USERRA reemployment rights, see [reemployment guidance](${job.url}); for SCRA residential lease termination, see [lease termination guidance](${lease.url}).`);
    }
  }
  const isScra = /\bscra\b|servicemembers civil relief/i.test(q);
  if (isScra && !/\b(?:guard|title\s*32)\b/i.test(q) && /\b(?:lease|landlord|rent)\b/i.test(q) &&
    /\b(?:loan|interest|credit)\b/i.test(q) &&
    /\b(?:lease|landlord)\b/i.test(answer) && /\b(?:loan|interest)\b/i.test(answer)) {
    // These verified, section-level U.S. Code authorities avoid attributing
    // the lease and interest claims to an unrelated Law Review article.
    lines.push(`For residential lease termination, see [50 U.S.C. § 3955](${scraLeaseStatuteUrl}); for interest on pre-service debts, see [50 U.S.C. § 3937](${scraInterestStatuteUrl}).`);
  }
  if (isScra && /\b(?:guard|title\s*32)\b/i.test(q)) {
    const topics = [];
    if (/\b(?:lease|landlord|rent)\b/i.test(q) && /\b(?:lease|landlord|rent)\b/i.test(answer)) {
      topics.push(`[50 U.S.C. § 3955](${SCRA_LEASE_URL}) for residential lease termination`);
    }
    if (/\b(?:loan|interest|credit)\b/i.test(q) && /\b(?:loan|interest|credit)\b/i.test(answer)) {
      topics.push(`[50 U.S.C. § 3937](${SCRA_INTEREST_URL}) for interest on pre-service debts`);
    }
    if (topics.length) lines.push(`For Guard coverage see [50 U.S.C. § 3911](${SCRA_SERVICE_URL}); see ${topics.join(" and ")}.`);
  }
  return lines.length ? `\n\nSource attribution:\n${lines.join("\n")}` : "";
}

function visibleAnswerSources(answer, sourceDocuments = [], verifiedUrls = []) {
  // Retrieval is evidence supplied to the model, not proof that every chunk
  // contributed to its answer. Show only links actually cited in the final text.
  const allowed = new Map(
    [...sourceDocuments.map(doc => publicSourceUrl(doc.url)), ...verifiedUrls,
      SCRA_LEASE_URL, SCRA_INTEREST_URL, SCRA_SERVICE_URL]
      .filter(url => /^https?:\/\//i.test(url || ""))
      .map(url => [normalizeSourceUrl(url), url])
  );
  const cited = String(answer || "").match(/https?:\/\/[^\s<>"\])]+/gi) || [];
  return [...new Set(cited
    .map(url => allowed.get(normalizeSourceUrl(url.replace(/[.,;:!?]+$/, ""))))
    .filter(Boolean))].slice(0, 3);
}

const SOURCE_STOP_WORDS = new Set([
  "about", "after", "against", "also", "answer", "because", "benefit", "could",
  "does", "from", "have", "help", "military", "member", "more", "question",
  "regarding", "service", "their", "there", "these", "this", "those", "what",
  "when", "where", "which", "with", "would", "your",
]);
function sourceTopicTerms(value) {
  return new Set((String(value || "").toLowerCase().match(/[a-z]{4,}/g) || [])
    .map(word => word.replace(/(?:ing|ed|es|s)$/, ""))
    .filter(word => word.length >= 4 && !SOURCE_STOP_WORDS.has(word)));
}

function supplementalSourceLinks(question, answer, sourceDocuments = []) {
  // A retrieved chunk is not automatically a citation. Add reading links only
  // when both the question and the answer share substantive terms with its text.
  const questionTerms = sourceTopicTerms(question);
  if (questionTerms.size < 2) return "";
  const answerTerms = sourceTopicTerms(answer);
  const cited = new Set(visibleAnswerSources(answer, sourceDocuments).map(normalizeSourceUrl));
  if (cited.size >= 3) return "";
  const seen = new Set(cited);
  const candidates = sourceDocuments.flatMap(doc => {
    const url = publicSourceUrl(doc.url);
    if (!/^https:\/\//i.test(url || "") || !doc.text || seen.has(normalizeSourceUrl(url))) return [];
    const terms = sourceTopicTerms(`${doc.title || ""} ${doc.text}`);
    const overlap = [...questionTerms].filter(term => terms.has(term)).length;
    const answerOverlap = [...answerTerms].filter(term => terms.has(term)).length;
    if (overlap < 2 || answerOverlap < 2) return [];
    seen.add(normalizeSourceUrl(url));
    return [{ url, title: String(doc.title || "").replace(/[[\]\n\r]/g, "").slice(0, 90),
      score: overlap * 2 + answerOverlap }];
  }).sort((a, b) => b.score - a.score).slice(0, 3 - cited.size);
  if (!candidates.length) return "";
  return `\n\nFurther relevant sources:\n${candidates.map(doc =>
    `- [${doc.title || "Source document"}](${doc.url})`).join("\n")}`;
}

// Keep high-ranking chunks from one document from crowding every other
// authority out of the context. The first pass preserves the existing ranking
// (including pinned policy chunks), while reserving a slot for each distinct
// canonical document/source URL. A second pass fills remaining capacity with
// additional chunks when there are not enough distinct documents.
function selectDiverseMatches(candidates, limit, sourceKey = match => (
  normalizeSourceUrl(match?.metadata?.url || match?.metadata?.source || match?.id)
), requiredCandidates = []) {
  const seenIds = new Set();
  const unique = candidates.filter(match => {
    if (!match || seenIds.has(match.id)) return false;
    seenIds.add(match.id);
    return true;
  });
  const selected = [];
  const seenSources = new Set();
  for (const match of unique) {
    if (selected.length >= limit) break;
    const source = sourceKey(match) || `id:${match.id}`;
    if (!seenSources.has(source)) {
      seenSources.add(source);
      selected.push(match);
    }
  }
  for (const match of unique) {
    if (selected.length >= limit) break;
    if (!selected.includes(match)) selected.push(match);
  }
  // A focused legal query can return a long run of Law Center documents
  // before the general query's official result. Reserve a slot for explicitly
  // required candidates without disturbing the first-ranked priority items.
  for (const required of requiredCandidates) {
    if (!required || selected.some(item => item.id === required.id)) continue;
    const requiredSource = sourceKey(required) || `id:${required.id}`;
    if (selected.some(item => (sourceKey(item) || `id:${item.id}`) === requiredSource)) continue;
    // Replace the lowest-ranked optional result; pinned items lead the list.
    const replacementIndex = selected.findLastIndex(item => !requiredCandidates.some(item2 => item2?.id === item.id));
    if (replacementIndex < 0) break;
    selected[replacementIndex] = required;
  }
  return selected;
}

const articleCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, "lr-articles.json"), "utf8"));
const lawReviewUrls = new Set(
  articleCatalog
    .filter(article => article.source === "ROA Service Members Law Center")
    .map(article => normalizeSourceUrl(article.url))
);

const app = express();

app.disable("x-powered-by");
// Public installation remains blocked until ROA approves it. Apply this
// before parsing a request body, including CORS preflight.
const publicSiteHosts = new Set(["roa.org", "www.roa.org"]);
app.use((req, res, next) => {
  const origin = req.get("Origin");
  let originHost = "";
  try { originHost = new URL(origin).hostname.toLowerCase(); } catch { /* no valid Origin */ }
  const host = (req.get("host") || "").split(":")[0].toLowerCase();
  if (publicSiteHosts.has(originHost) || publicSiteHosts.has(host)) {
    return res.status(403).json({ error: "Public-site chat is not available" });
  }
  if (origin) {
    res.vary("Origin");
    let sameOrigin = false;
    try {
      const browserOrigin = new URL(origin);
      const requestHost = new URL(`http://${req.get("host")}`);
      sameOrigin = browserOrigin.host === requestHost.host ||
        (browserOrigin.hostname === requestHost.hostname &&
          browserOrigin.port === String(req.socket.localPort));
    } catch {
      // Invalid Origin is rejected below.
    }
    if (!sameOrigin) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    if (req.path === "/chat") return res.sendStatus(204);
    return res.sendStatus(404);
  }
  next();
});
// Authenticate the operator-only route before parsing its body. Keep the
// existing Origin/CORS policy above unchanged.
app.post("/api/source-pack", sourcePackAuthentication());
app.use(express.json({ limit: "64kb" }));
// The default Express error handler can log a malformed JSON payload. Reject
// parser errors here without echoing or logging any part of a message body.
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return res.status(err.status || 400).json({ error: "Invalid request body" });
  }
  next(err);
});

// Render has one trusted proxy hop. The IP key lives only in memory for the
// rate window; never write it to a database, file or application log.
app.set("trust proxy", 1);
function limitRequests(max, windowMs) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let record = clients.get(key);
    if (!record || now >= record.until) {
      for (const [ip, entry] of clients) {
        if (now >= entry.until) clients.delete(ip);
      }
      if (clients.size >= 10000) return res.status(429).json({ error: "Too many requests" });
      record = { count: 0, until: now + windowMs };
      clients.set(key, record);
    }
    if (++record.count > max) {
      res.set("Retry-After", String(Math.ceil((record.until - now) / 1000)));
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

function chatFailureMessage(err) {
  // Anthropic's SDK error can contain request text. Inspect only the provider's
  // billing classification; never send or log its raw error.
  const providerError = err?.error?.error;
  if (err?.status === 400 && providerError?.type === "invalid_request_error" &&
      /credit balance|billing|purchase credits|insufficient credits/i.test(String(providerError.message || ""))) {
    return "Chat is temporarily unavailable because the AI service account needs billing attention. Please contact ROA and try again later.";
  }
  return "Something went wrong. Please try again.";
}

// --- Serve only the public chatbot assets ---
// Do not use express.static here: the chatbot directory contains credentials
// captured during the gate, configuration, reports, source, and runtime state.
// Keep this allowlist explicit so adding a project file cannot publish it.
const workspaceRoot = path.join(__dirname, "..");
const publicAssets = new Map([
  ["/", path.join(__dirname, "testpage.html")],
  ["/testpage.html", path.join(__dirname, "testpage.html")],
  ["/widget-preview.html", path.join(workspaceRoot, "test.html")],
  ["/logo.png", path.join(workspaceRoot, "logo.png")],
  ["/reserveconnect-ai-explorer-logo.png", path.join(workspaceRoot, "reserveconnect-ai-explorer-logo.png")],
  ["/lawcenter.webp", path.join(workspaceRoot, "lawcenter.webp")],
  ["/widget.js", path.join(workspaceRoot, "widget.js")],
]);
for (const [url, file] of publicAssets) {
  app.get(url, (req, res) => res.sendFile(file));
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Pinecone setup ---
// Never query the mixed-model legacy index with Voyage vectors.
const pineconeIndexName = KNOWLEDGE_INDEX;
let pineconeIndexHost = null;

if (isMainModule && process.env.PINECONE_API_KEY) {
  try {
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const indexInfo = await pinecone.describeIndex(pineconeIndexName);
    assertKnowledgeIndex(indexInfo);

    // Grab the host so we can query the REST API directly with plain text
    pineconeIndexHost = indexInfo?.host || null;
    console.log(`✅ Pinecone connected — host: ${pineconeIndexHost}`);
    try {
      const groups = await verifyPinnedChunks(pinecone.index(pineconeIndexName));
      const missing = groups.flatMap(group => group.missing.map(id => `${group.label}: ${id}`));
      if (missing.length) console.warn(`⚠️  Missing pinned knowledge-base chunks:\n${missing.join("\n")}`);
      else console.log(`✅ Verified ${groups.reduce((total, group) => total + group.present.length, 0)} pinned chunks`);
    } catch {
      console.warn("⚠️  Could not verify pinned knowledge-base chunks at startup");
    }
  } catch (err) {
    console.warn("⚠️  Pinecone init failed:", err.message);
  }
} else if (isMainModule) {
  console.warn("⚠️  PINECONE_API_KEY not set — running without knowledge base");
}

// --- Query routing ---
// Legal questions need Reserve Service Law Center material first. Other questions should use the
// full ingested corpus instead of being biased toward legal PDFs.
const QUERY_ROUTES = [
  {
    key: "va",
    legal: false,
    pattern: { test: isVaDisabilityQuestion },
  },
  {
    key: "legal",
    legal: true,
    pattern: /\b(law|legal|lawyer|attorney|jag|userr?a|scra|ucmj|employ(?:er|ment)?|civilian job|job back|layoff|laid off|military leave|reemploy|fired|firing|terminated|discriminat|wrongful|separat|discharg|court martial|appeal|board|peb|mEB|line of duty|record correction|clearance|rights?)\b/i,
  },
  {
    key: "pay",
    legal: false,
    pattern: /\b(pay|paid|paycheck|drill pay|basic pay|allowance|bah|bas|travel|reimburs|mileage|per diem|tdy|pds|special pay|bonus|compensation|les|deduction|retirement pay)\b/i,
  },
  {
    key: "benefits",
    legal: false,
    pattern: /\b(benefit|tricare|health|insurance|gi bill|education|scholarship|va disability|disability rating|veteran|retiree|retiring|transition|transitioning|leaving the (guard|reserve)|sgli|tsp|home loan|va claim|crdp|crsc)\b/i,
  },
];

const SEARCH_EXPANSIONS = {
  va: "VA disability compensation claims ratings evidence service connection presumptive conditions appeals",
  legal: "ROA Reserve Service Law Center law library article military legal rights USERRA SCRA UCMJ employment reemployment administrative separation",
  pay: "Reserve Component military pay DFAS JTR BAH BAS travel reimbursement special pay compensation drill pay LES",
  benefits: "Reserve Component benefits VA disability TRICARE retirement education GI Bill veteran eligibility official guidance",
  general: "Reserve Component service member resources benefits policy guidance",
};

const VALID_CHAT_MODES = new Set(Object.keys(config.chatModes));
// A browser tab sends only its small pathway state with each request. Never
// cache messages, prompts, answers or visitor identifiers on the server.
function readConversationState(input) {
  const state = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const initial = newTransitionIntake();
  const stage = ["not_started", "q1", "q2", "q3", "completed"].includes(state.intake?.stage)
    ? state.intake.stage : initial.stage;
  const answers = Object.fromEntries(["q1", "q2", "q3"].map(key => [
    key, (/^[A-E]$/.test(state.intake?.answers?.[key]) ||
      (key === "q1" && ["retiring", "separating"].includes(state.intake?.answers?.[key])) ||
      (key === "q2" && /^months:\d{1,3}$/.test(state.intake?.answers?.[key]) &&
        Number(state.intake.answers[key].slice(7)) <= 600)) ? state.intake.answers[key] : null,
  ]));
  const payTraining = ["confirm", "grade", "later"].includes(state.payTraining?.stage)
    ? { stage: state.payTraining.stage, type: ["AT", "ADT"].includes(state.payTraining.type) ? state.payTraining.type : null }
    : null;
  return {
    crisisActive: state.crisisActive === true,
    dd214AwarenessAsked: state.dd214AwarenessAsked === true,
    dd214PathwayState: normalizeDd214PathwayState(state.dd214PathwayState),
    transitionEligible: state.transitionEligible === true,
    intake: { stage, answers },
    payTraining,
    payFacts: sanitizePayFacts(state.payFacts),
    lastPayQuestion: ["yearsOfService", "dependents"].includes(state.lastPayQuestion) ? state.lastPayQuestion : null,
    bahLookup: sanitizeBahLookupState(state.bahLookup),
    drillPayLookup: state.drillPayLookup?.active === true ? {
      active: true,
      grade: typeof state.drillPayLookup.grade === "string" ? state.drillPayLookup.grade.slice(0, 6) : null,
      years: Number.isFinite(state.drillPayLookup.years) && state.drillPayLookup.years >= 0 && state.drillPayLookup.years <= 60
        ? state.drillPayLookup.years : null,
    } : null,
    ...(state.serviceYears === null || (Number.isInteger(state.serviceYears) && state.serviceYears >= 0 && state.serviceYears <= 60)
      ? { serviceYears: state.serviceYears } : {}),
  };
}

function normalizeChatMode(value, lawCenterOnly = false) {
  if (value === undefined || value === null || value === "") {
    return lawCenterOnly === true ? "law_center" : "general";
  }
  return typeof value === "string" && VALID_CHAT_MODES.has(value) ? value : null;
}

function routeForMode(chatMode, message) {
  if (chatMode === "law_center") return QUERY_ROUTES.find(route => route.key === "legal");
  if (chatMode === "general") return classifyQuery(message);
  const modeCategory = config.chatModes[chatMode]?.category;
  return {
    key: modeCategory,
    legal: false,
    pattern: null,
  };
}

const EMPLOYMENT_DISPUTE_PATTERN =
  /(?:\b(company|boss|supervisor|workplace)\b[\s\S]{0,120}\b(job|position|promotion|pay|leave|return)\b)|(?:\b(job|position|promotion|leave|return)\b[\s\S]{0,120}\b(company|boss|supervisor|workplace)\b)/i;

function isLeaseRightsQuestion(message) {
  const text = String(message || "");
  return /\b(?:lease|rental agreement)\b/i.test(text) &&
    /\b(?:cancel(?:led|ling|ed|ing)?|terminat(?:e|ed|ing|ion)|break|breaking|end|ending|evict(?:ion|ed)?|landlord)\b/i.test(text);
}

function classifyQuery(message) {
  if (EMPLOYMENT_DISPUTE_PATTERN.test(message) || isLeaseRightsQuestion(message)) return QUERY_ROUTES.find(route => route.key === "legal");
  const route = QUERY_ROUTES.find(candidate => candidate.pattern.test(message));
  return route || { key: "general", legal: false, pattern: null };
}

function isPayPolicyQuery(message) {
  return QUERY_ROUTES.find(route => route.key === "pay").pattern.test(message);
}

function isBahQuery(message) {
  return /\b(BAH|Basic Allowance for Housing|housing allowance|Annual Training|AT orders?)\b/i.test(message);
}

function isDd214PathwayQuery(message) {
  return /\b(transition(?:ing)?|separat(?:e|es|ed|ing|ion)|administrative separation|retir(?:e|es|ed|ing|ement)|get(?:ting)?\s+out|leav(?:e|es|ing)\s+(?:(?:my|the|a)\s+)?(?:active\s+(?:duty|service)|service|military|(?:(?:Army|Air Force|Navy|Marine Corps|Coast Guard)\s+)?(?:National Guard|Guard|Reserve|Reserve Component))|discharg(?:e|es|ed|ing)|release(?:d)? from active (?:duty|service)|DD\s*(?:Form\s*)?-?\s*214(?:-1)?)\b/i.test(message);
}

function isUserLeavingService(message) {
  const departure = /\b(?:transitioning(?:\s+out)?|transition(?:ing)?\s+out|separat(?:e|es|ed|ing|ion)|retir(?:e|es|ed|ing)|get(?:ting)?\s+out|leav(?:e|es|ing)\s+(?:(?:my|the|a)\s+)?(?:active\s+(?:duty|service)|service|military|(?:Army|Air Force|Navy|Marine Corps|Coast Guard|National Guard|Guard|Reserve)(?:\s+(?:Guard|Reserve|Component))?)|discharg(?:e|es|ed|ing)|releas(?:e|ed)\s+from\s+active\s+(?:duty|service))\b/gi;
  for (const clause of String(message || "").split(/[.!?;\n]+/)) {
    if (!/\b(?:I|I'm|I’ve|I've|we|we're|my\s+(?:separation|retirement|discharge|release))\b/i.test(clause)) continue;
    for (const match of clause.matchAll(departure)) {
      const prefix = clause.slice(0, match.index);
      if (/\b(?:not|never|don't|do not|no longer|isn't|aren't|haven't|have not)\b(?:\s+\w+){0,2}\s*$/i.test(prefix) ||
          /\b(?:not sure (?:if|whether)|just asking (?:about|if))\b/i.test(prefix)) continue;
      return true;
    }
  }
  return false;
}

function isUserDenyingDeparture(message) {
  return /\b(?:I(?:'m| am)?|we(?:'re| are)?)\s+(?:am\s+)?(?:not|never|don't|do not)\s+(?:(?:currently|actually|planning|going|being)\s+){0,2}(?:transitioning|separating|retiring|leaving|getting out|being discharged)\b|\bI (?:didn't|did not|never) say I (?:was|am) (?:separating|leaving|retiring|transitioning)\b/i.test(message);
}

function pathwayTurn(message, intakeStage, dd214State, dd214Reply = message) {
  const intakeActive = ["q1", "q2", "q3"].includes(intakeStage);
  const dd214Active = ["awareness_asked", "review_offered"].includes(dd214State);
  const intakeChoice = intakeActive && parseTransitionAnswer(intakeStage, message) !== null;
  const dd214Choice = dd214Active &&
    advanceDd214PathwayState(dd214State, dd214Reply, true) !== dd214State;
  const ambiguousChoice = intakeActive &&
    /^(?:[a-e]\s+(?:or|and)\s+[a-e]|(?:not sure|i don't know|unsure))\.?$/i.test(message.trim());
  const hasNewQuestion = message.includes("?") ||
    /^(?:what|why|how|where|when|can|could|should|does|do|is|are|tell me|help me)\b/i.test(message.trim());
  return {
    offPathway: (intakeActive || dd214Active) &&
      (hasNewQuestion || (intakeActive && !intakeChoice && !ambiguousChoice) ||
        (dd214Active && !dd214Choice)),
    ambiguousChoice,
  };
}

function normalizeDd214PathwayState(value) {
  return ["not_started", "awareness_asked", "review_offered", "completed"].includes(value)
    ? value
    : "not_started";
}

function advanceDd214PathwayState(state, message, pathwayTriggered) {
  const current = normalizeDd214PathwayState(state);
  if (current === "completed") return current;
  if (current === "not_started") {
    return pathwayTriggered ? "awareness_asked" : current;
  }

  const answer = String(message || "").trim();
  const yes = /^(?:a(?:\s*$|[).:-]\s*)|yes\b|yeah\b|yep\b|sure\b)/i.test(answer);
  const noOrUnsure = /^(?:[bc](?:\s*$|[).:-]\s*)|no\b|not sure\b|unsure\b|i(?:'m| am)\s+not sure\b|i (?:do not|don't) know\b|actually,\s*no\b|absolutely not\b)/i.test(answer);

  if (current === "awareness_asked") {
    const volunteered = volunteeredDd214Awareness(answer);
    if (volunteered !== null) return volunteered ? "completed" : "review_offered";
    if (noOrUnsure) return "review_offered";
    if (yes) return "completed";
  } else if (current === "review_offered" && (yes || noOrUnsure)) {
    return "completed";
  }
  return current;
}

function recordUrl(match) {
  return String(match?.metadata?.url || "");
}

function isDodFmrVolume7aMatch(match) {
  const metadata = match?.metadata || {};
  return metadata.source === dodFmrVolume7aSource ||
    metadata.filename === "Volume_07a.pdf" ||
    /DoD 7000\.14-R Financial Management Regulation Volume 7A/i.test(String(metadata.text || ""));
}

function isDodi133601Match(match) {
  const metadata = match?.metadata || {};
  return metadata.source === dodi133601Source ||
    metadata.filename === "133601p.pdf" ||
    /DoDI 1336\.01/i.test(String(metadata.text || ""));
}

function isRoaPayMatrixMatch(match) {
  const metadata = match?.metadata || {};
  return /(?:ROA\s+)?RC Duty Status Benefits Matrix|duty[_ -]?status[_ -]?matrix/i.test(
    `${metadata.title || ""} ${metadata.source || ""} ${metadata.url || ""}`
  );
}

function isLawReviewUrl(url) {
  if (lawReviewUrls.has(normalizeSourceUrl(url))) return true;
  try {
    const parsed = new URL(url);
    return /^(?:assets\.|www\.)?roa\.org$/i.test(parsed.hostname) &&
      /\/(?:\d{5}-LR|LR\d{5}[^/]*)\.pdf$/i.test(parsed.pathname);
  } catch { return false; }
}

function isOfficialPolicyUrl(url) {
  return /esd\.whs\.mil|defense\.gov|dod\.mil|militaryonesource\.mil|defensetravel\.dod\.mil|army\.mil|af\.mil|navy\.mil|marines\.mil|uscg\.mil|dfas\.mil|tricare\.mil|va\.gov/i.test(url);
}

function trimToLastCompleteSentence(text) {
  const value = String(text || "").trim();
  let lastCompleteEnd = 0;
  for (const { segment, index } of new Intl.Segmenter("en", { granularity: "sentence" }).segment(value)) {
    const trimmed = segment.trim();
    if (!/^\d+\.$/.test(trimmed) && /[.!?](?:["')\]]*)?$/.test(trimmed)) {
      lastCompleteEnd = index + segment.length;
    }
  }
  if (lastCompleteEnd === 0) {
    return "The available Reserve Service Law Center articles require a narrower follow-up question for a complete answer.";
  }
  return value
    .slice(0, lastCompleteEnd)
    .trim()
    .replace(/\n\s*\d+\.\s*$/, "")
    .trim();
}

function normalizeLawCenterName(text) {
  const placeholder = "__RESERVE_SERVICE_LAW_CENTER__";
  return String(text || "")
    .replace(/Reserve Service Law Center/gi, placeholder)
    .replace(/\b(?:ROA(?:'s)?\s+)?Service Members Law Center\b/gi, placeholder)
    .replace(/\bROA Law Center\b/gi, placeholder)
    .replace(/\bThe Law Center\b/g, `The ${placeholder}`)
    .replace(/\bthe Law Center\b/g, `the ${placeholder}`)
    .replace(/\bLaw Center\b/g, placeholder)
    .replaceAll(placeholder, "Reserve Service Law Center");
}

function ensureCompleteAnswer(text) {
  const value = String(text || "").trim();
  const hadBanner = /\[LAW_CENTER_BANNER\]/.test(value);
  const answerText = normalizeLawCenterName(
    value.replace(/\[LAW_CENTER_BANNER\]/g, "").trim()
  ).split("\n").map(line => {
    const trimmed = line.trim();
    return /^[A-Z]\)\s+\S/.test(trimmed) && !/[.!?]$/.test(trimmed)
      ? `${line}.`
      : line;
  }).join("\n");
  const completed = /[.!?](?:["')\]]*)?$/.test(answerText)
    ? answerText
    : /(?:https?:\/\/\S+|(?:www\.)?[\w.-]+\.[a-z]{2,})(?:\/\S*)?$/i.test(answerText)
    ? `${answerText}.`
    : trimToLastCompleteSentence(answerText);
  return hadBanner ? `${completed}\n\n[LAW_CENTER_BANNER]` : completed;
}

function correctDd214IssuanceClaims(text) {
  const value = String(text || "");
  const paragraphs = value.split(/\n{2,}/);
  let corrected = false;
  const result = paragraphs.map(paragraph => {
    const claimsDd256Substitution =
      /DD\s*Form\s*256/i.test(paragraph) &&
      (
        /instead of (?:a )?DD[-\s]*(?:Form\s*)?214/i.test(paragraph) ||
        /drill\/?IDT|inactive duty training|180 days/i.test(paragraph)
      );
    if (!claimsDd256Substitution) return paragraph;
    corrected = true;
    return "**Reserve Component separation record:** Under DoDI 1336.01, a member who is separated or released from a Reserve Component must be issued a DD Form 214 and DD Form 214-1 together. The DD Form 214-1 is never issued alone. Drill/IDT-only service and the absence of active-duty orders over 180 days do not replace this requirement with a DD Form 256.";
  }).join("\n\n");
  return corrected ? result : value;
}

// Fetch pinecone index object (used for direct chunk fetches)
const pineconeClient = process.env.PINECONE_API_KEY
  ? new Pinecone({ apiKey: process.env.PINECONE_API_KEY })
  : null;

// --- Embed query using Voyage AI (voyage-law-2) ---
async function embedQuery(text, { signal } = {}) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: KNOWLEDGE_MODEL,
      input: [text],
      input_type: "query",
    }),
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Voyage embed failed ${resp.status}: ${JSON.stringify(err)}`);
  }
  const body = await resp.json();
  return body.data[0].embedding;
}

// --- Query Pinecone with Voyage AI embeddings ---
async function getKnowledgeBaseContext(
  message,
  {
    chatMode = "general",
    question = message,
    evidenceQuestion = question,
    forceDd214Pathway = null,
    includeDd214Policy = false,
    // Inject retrieval services for deterministic tests; production uses live services.
    retrievalClient = {
      indexHost: pineconeIndexHost,
      embed: embedQuery,
      fetch: globalThis.fetch,
      pinecone: pineconeClient,
    },
  } = {}
) {
  if (!retrievalClient.indexHost) {
    return { status: "unavailable", context: null };
  }

  try {
    const lawCenterOnly = chatMode === "law_center";
    const route = routeForMode(chatMode, question);
    const cfrPlans = lawCenterOnly ? [] : vaCfrPlans(`${question}\n${evidenceQuestion}`);
    const vaDisabilityQuestion = isVaDisabilityQuestion(question) || cfrPlans.length > 0;
    const trainingAuthorityQuery = !lawCenterOnly &&
      isTrainingServiceResearch(`${question}\n${evidenceQuestion}`);
    const veteranDefinitionQuery = isVeteranDefinitionQuestion(question) || trainingAuthorityQuery;
    // Service-definition research also needs the implementing regulation, but
    // must not turn a neutral Veteran-status intake into a disability question.
    if (trainingAuthorityQuery && !cfrPlans.some(plan => plan.section === "3.6")) {
      cfrPlans.push({ key: "3.6", section: "3.6", preferred: /disabled or died.{0,500}injury/i });
    }
    const payPolicyQuery = !vaDisabilityQuestion && !lawCenterOnly && (chatMode === "pay" || isPayPolicyQuery(question));
    const dd214PathwayQuery =
      !lawCenterOnly &&
      (forceDd214Pathway === null
        ? isDd214PathwayQuery(question)
        : forceDd214Pathway === true);
    const dd214PolicyQuery = dd214PathwayQuery || (!lawCenterOnly && includeDd214Policy);
    // 1. Embed the user's wording plus a route-specific vocabulary expansion.
    // This is especially important for short quick-action prompts such as
    // "My pay is a mess," which otherwise may not clear the similarity floor.
    const retrievalFocus = [
      isLeaseRightsQuestion(question)
        ? "SCRA residential lease termination military orders landlord notice 50 USC 3955"
        : "",
      dd214PolicyQuery
        ? "DoDI 1336.01 DD Form 214-1 issuance delivery Table 2"
        : "",
      payPolicyQuery ? "DFAS JTR travel reimbursement BAH drill pay DoD FMR Volume 7A" : "",
       chatMode === "general" && route.key === "va"
         ? SEARCH_EXPANSIONS.va
         : config.chatModes[chatMode]?.retrievalExpansion?.split(/\s+/).slice(0, 8).join(" "),
      // Focused modes already supply their own vocabulary; the broad benefits
      // expansion also pulls VA sources into unrelated Benefits searches.
      (chatMode === "general" || chatMode === "law_center")
        ? SEARCH_EXPANSIONS[route.key]?.split(/\s+/).slice(0, 6).join(" ") : "",
      payPolicyQuery && route.key !== "pay" ? SEARCH_EXPANSIONS.pay?.split(/\s+/).slice(0, 5).join(" ") : "",
    ].filter(Boolean).join(" ").split(/\s+/).slice(0, 24).join(" ");
    const expandedQuery = veteranDefinitionQuery
      ? `${message}\nVeteran status and benefit eligibility: 38 USC 101 definition active military naval air space service discharge; 38 CFR 3.1(d) and 3.6 active duty ADT IDT qualifying service. Use applicable benefit rules, not DD214 issuance alone.`
      : vaDisabilityQuestion
      ? `${question}\nVA disability source evidence`
      : retrievalFocus ? `${message}\nRetrieval focus: ${retrievalFocus}` : message;
    const queryVector = await retrievalClient.embed(expandedQuery);

    // 2. Full-mode searches query the complete corpus. Search Law Center
    // articles for every question, not just questions matching legal keywords.
    // Law Center-only searches skip the complete-corpus query entirely.
    const queryBody = {
      vector: queryVector,
      includeMetadata: true,
      includeValues: false,
      namespace: "",
    };

    const pineconeHeaders = {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2024-10",
    };

    let generalResults = { matches: [] };
    if (!lawCenterOnly) {
      generalResults = await queryKnowledgeIndex(retrievalClient, {
        vector: queryVector,
        topK: route.legal ? 18 : payPolicyQuery || route.key === "va" ? 24 : 12,
      });
    }
    let trainingAuthorityMatches = [];
    let trainingAuthorityRecoveryFailed = false;
    if (trainingAuthorityQuery) {
      try {
        const results = await queryKnowledgeIndex(retrievalClient, {
          vector: queryVector, topK: 64, filter: TRAINING_STATUTE_FILTER,
          signal: AbortSignal.timeout(10000),
        });
        trainingAuthorityMatches = selectTrainingAuthority([
          ...(results.matches || []), ...(generalResults.matches || []),
        ]);
      } catch {
        trainingAuthorityRecoveryFailed = true;
        trainingAuthorityMatches = selectTrainingAuthority(generalResults.matches || []);
        console.warn("Training authority lookup unavailable; continuing other member-source research.");
      }
    }
    const trainingAuthorityKeys = new Set(trainingAuthorityMatches.map(match => {
      const doc = sourceDocument(match);
      return `${doc.url}\n${doc.text}`;
    }));
    let vaFocusedMatches = [];
    let cfrRecoveryFailures = 0;
    const exactCfrResults = await Promise.all([...new Set(cfrPlans.map(plan => plan.section))]
      .map(async section => {
        try {
          return await queryKnowledgeIndex(retrievalClient, {
            vector: queryVector, topK: 64, filter: { section: { $eq: section } },
            signal: AbortSignal.timeout(10000),
          });
        } catch {
          cfrRecoveryFailures += 1;
          console.warn("Targeted CFR recovery unavailable; continuing ordinary retrieval.");
          return { matches: [] };
        }
      }));
    let proposalMatches = [];
    let proposalRecoveryFailed = false;
    if (vaDisabilityQuestion && !lawCenterOnly && isSusanLukasResearchQuestion(evidenceQuestion)) {
      const proposal = verifiedUploadedSource(SUSAN_LUKAS_DOCUMENT);
      if (proposal) {
        try {
          const vector = await retrievalClient.embed(
            "Susan E. Lukas Act H.R. 5339 proposed legislation eligibility cohort Pentagon September 11 VA health care disability compensation presumptions ROA testimony",
          );
          const identities = [proposal.originalSource, proposal.originalFilename, proposal.url];
          const results = await queryKnowledgeIndex(retrievalClient, {
            vector, topK: 12,
            filter: { $or: [
              { source: { $in: identities } }, { url: { $in: identities } },
            ] },
            signal: AbortSignal.timeout(10000),
          });
          proposalMatches = (results.matches || []).filter(match => {
            const doc = sourceDocument(match);
            return doc.legalStatus === "proposal-discussion" && doc.url === proposal.url;
          });
        } catch {
          proposalRecoveryFailed = true;
          console.warn("Targeted proposal recovery unavailable; continuing other member-source retrieval.");
        }
      }
    }
    if (vaDisabilityQuestion) {
      const focusedVector = await retrievalClient.embed(focusedVaSearchQuery(evidenceQuestion));
      const focusedResults = await queryKnowledgeIndex(retrievalClient, {
        vector: focusedVector, topK: 30,
        ...(lawCenterOnly ? { filter: { type: { $eq: "law-center-pdf" } } } : {}),
      });
      const officialResults = lawCenterOnly ? { matches: [] } : await queryKnowledgeIndex(retrievalClient, {
        vector: focusedVector, topK: 20,
        filter: { sourceKind: { $eq: "official-regulation" } },
      });
      const contextResults = await Promise.all(injuryContextSearches(evidenceQuestion).map(async query => {
        const vector = await retrievalClient.embed(query);
        return queryKnowledgeIndex(retrievalClient, {
          vector, topK: 20,
          ...(lawCenterOnly ? { filter: { type: { $eq: "law-center-pdf" } } } : {}),
        });
      }));
      const injuryContextMatches = contextResults.flatMap(result => result.matches || []);
      if (lawCenterOnly) {
        // Merge these below into the article-only search, not the full corpus.
        vaFocusedMatches = [...(focusedResults.matches || []), ...injuryContextMatches];
      } else {
        generalResults.matches = [...(generalResults.matches || []), ...(focusedResults.matches || []),
          ...(officialResults.matches || []), ...injuryContextMatches];
      }
    }
    let veteranDefinitionMatches = [];
    if (veteranDefinitionQuery) {
      try {
        const results = await queryKnowledgeIndex(retrievalClient, {
          vector: queryVector, topK: 8,
          filter: { url: { $eq: VETERAN_DEFINITION_URL } },
          signal: AbortSignal.timeout(10000),
        });
        veteranDefinitionMatches = (results.matches || []).filter(isVeteranDefinitionMatch);
      } catch {
        // An optional preferred reference must not discard full-corpus results.
        // Do not expose provider errors or search mechanics in member answers.
        console.warn("Preferred Veteran reference lookup unavailable; continuing other research.");
      }
    }

    let lawResp = null;
    let lawResults = { matches: [] };
    lawResp = await retrievalClient.fetch(`https://${retrievalClient.indexHost}/query`, {
      method: "POST",
      headers: pineconeHeaders,
      body: JSON.stringify({
        ...queryBody,
        topK: 12,
        filter: { type: { $eq: "law-center-pdf" } },
      }),
    });
    lawResults = await lawResp.json();
    if (!lawResp.ok) throw new Error("Law Center query failed");

    // A blended embedding may mostly retrieve one side of a two-issue legal
    // question. Search each issue separately, then accept only chunks whose
    // text actually supports that issue.
    const mixedFamilies = !lawCenterOnly ? requiredAuthorityFamilies(question) : [];
    const focusedMatches = [];
    const focusedByFamily = {};
    for (const [family, focus] of mixedFamilies.map(family => [family, {
      userraReemployment: "USERRA civilian job reemployment rights after military service escalator reinstatement",
      scraLease: "SCRA residential lease termination military orders notice landlord 50 USC 3955",
    }[family]])) {
      const vector = await retrievalClient.embed(focus);
      const response = await retrievalClient.fetch(`https://${retrievalClient.indexHost}/query`, {
        method: "POST",
        headers: pineconeHeaders,
        body: JSON.stringify({ ...queryBody, vector, topK: 16 }),
      });
      if (!response.ok) throw new Error(`Focused ${family} query failed: HTTP ${response.status}`);
      const results = await response.json();
      const supporting = (results.matches || []).find(match =>
        (match.score ?? 0) >= (config.fallbackMinScore ?? 0.48) &&
        authorityFamilies[family]({
          title: match.metadata?.title || "",
          text: match.metadata?.text || "",
        }) && /^https?:\/\//i.test(publicSourceUrl(recordUrl(match)))
      );
      if (supporting) {
        focusedMatches.push(supporting);
        focusedByFamily[family] = supporting;
      }
    }

    let fmrResp = null;
    let fmrResults = { matches: [] };
    if (payPolicyQuery) {
      fmrResp = await retrievalClient.fetch(`https://${retrievalClient.indexHost}/query`, {
        method: "POST",
        headers: pineconeHeaders,
        body: JSON.stringify({
          ...queryBody,
          topK: 8,
          filter: { source: { $eq: dodFmrVolume7aSource } },
        }),
      });
      fmrResults = await fmrResp.json();
      if (!fmrResp.ok) {
        throw new Error("DoD FMR Volume 7A query failed");
      }
    }

    // Voyage AI scores are naturally higher than multilingual-e5-large+ReLU.
    // Use one consistent threshold so route comparisons remain meaningful.
    const minScore = config.minScore ?? 0.60;
    const fallbackMinScore = config.fallbackMinScore ?? 0.48;
    const selectMatches = rawMatches => {
      // A strong unrelated match must not suppress a lower-scoring relevant
      // passage. Actual topic evidence is checked before context selection.
      if (vaDisabilityQuestion) return rawMatches.filter(m => (m.score ?? 0) >= fallbackMinScore);
      const strong = rawMatches.filter(m => (m.score ?? 0) >= minScore);
      if (strong.length > 0) return strong;
      return rawMatches.filter(m => (m.score ?? 0) >= fallbackMinScore).slice(0, 5);
    };
    const rawGeneralMatches = generalResults?.matches ?? [];
    const recoveredCfrMatches = recoverCfrMatches(cfrPlans, [
      ...exactCfrResults.flatMap(result => result.matches || []), ...rawGeneralMatches,
    ], sourceDocument);
    const recoveredCfrKeys = new Set(recoveredCfrMatches.map(match => {
      const document = sourceDocument(match);
      return `${document.url}\n${document.text}`;
    }));
    const generalMatches = selectMatches(rawGeneralMatches);
    const rawLawMatches = [...(lawResults?.matches ?? []),
      ...vaFocusedMatches];
    const lawOnlyCandidates = lawCenterOnly
      ? rawLawMatches.filter(m => isLawReviewUrl(recordUrl(m)))
      : rawLawMatches;
    const lawMatches = lawResp?.ok
      ? selectMatches(lawOnlyCandidates)
      : [];
    let requiredFmrMatches = [];
    if (payPolicyQuery && isBahQuery(question) && retrievalClient.pinecone) {
      const pinnedIndex = retrievalClient.pinecone.index(pineconeIndexName);
      const fetched = await pinnedIndex.fetch(dodFmrBahRequiredChunkIds);
      requiredFmrMatches = dodFmrBahRequiredChunkIds
        .map(id => ({ id, record: fetched.records?.[id] }))
        .filter(({ record }) => record?.metadata?.text)
        .map(({ id, record }) => ({
          id,
          score: 1,
          metadata: record.metadata,
        }));
    }

    const semanticFmrMatches = fmrResp?.ok
      ? selectMatches(fmrResults?.matches ?? []).filter(isDodFmrVolume7aMatch).slice(0, 6)
      : [];
    const fmrMatches = [];
    const seenFmrIds = new Set();
    for (const match of [...requiredFmrMatches, ...semanticFmrMatches]) {
      if (!seenFmrIds.has(match.id)) {
        seenFmrIds.add(match.id);
        fmrMatches.push(match);
      }
    }

    let dd214Matches = [];
    if (dd214PolicyQuery && retrievalClient.pinecone) {
      const pinnedIndex = retrievalClient.pinecone.index(pineconeIndexName);
      const fetched = await pinnedIndex.fetch(dd214PathwayChunkIds);
      dd214Matches = dd214PathwayChunkIds
        .map(id => ({ id, record: fetched.records?.[id] }))
        .filter(({ record }) => record?.metadata?.text)
        .map(({ id, record }) => ({ id, score: 1, metadata: record.metadata }));
    }

    let rankedMatches;
    let generalCandidates = [];
    if (lawCenterOnly) {
      rankedMatches = [...veteranDefinitionMatches, ...lawMatches];
    } else {
      generalCandidates = generalMatches.filter(match =>
        (!payPolicyQuery || !isRoaPayMatrixMatch(match)) &&
        (vaDisabilityQuestion || !isDodFmrVolume7aMatch(match)) &&
        (vaDisabilityQuestion || !isDodi133601Match(match))
      );
      // A non-legal route can still need a Law Center article. Include strong
      // articles that rank close to the full-corpus results, while allowing
      // ordinary pay/benefit documents to win when articles are less relevant.
      const topicalLawMatches = route.legal ? [] : vaDisabilityQuestion
        ? lawMatches.filter(match => isLawReviewUrl(recordUrl(match)))
        : lawMatches.filter(match =>
        isLawReviewUrl(recordUrl(match)) &&
        (match.score ?? 0) >= minScore &&
        (match.score ?? 0) >= (generalMatches[0]?.score ?? minScore) - 0.02
      );
      const ordinaryMatches = route.legal
        ? [...lawMatches, ...generalCandidates]
        : [...generalCandidates, ...topicalLawMatches]
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      rankedMatches = [
        ...veteranDefinitionMatches,
        ...dd214Matches,
        ...fmrMatches,
        ...focusedMatches,
        ...ordinaryMatches,
      ];
    }

    if (vaDisabilityQuestion) {
      const supported = new Set(preferInjuryRegulations(question, preferShoulderSchedule(question,
        relevantVaDisabilityDocuments(evidenceQuestion, rankedMatches.map(sourceDocument))))
        .map(document => `${document.url}\n${document.text}`));
      const seen = new Set();
      rankedMatches = rankedMatches.filter(match => {
        const document = sourceDocument(match);
        if (!supported.has(`${document.url}\n${document.text}`) &&
            !recoveredCfrKeys.has(`${document.url}\n${document.text}`)) return false;
        const key = `${sourceDocumentKey(match)}\n${document.text.replace(/\s+/g, " ").trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) =>
        (isShoulderRatingQuestion(question)
          ? Number(isOfficialShoulderSchedule(sourceDocument(b))) - Number(isOfficialShoulderSchedule(sourceDocument(a)))
          : 0) || (isInjuryResearchQuestion(question)
          ? Number(isCfrTitle38Source(sourceDocument(b))) - Number(isCfrTitle38Source(sourceDocument(a)))
          : 0) || sourceQualityRank(sourceDocument(b)) - sourceQualityRank(sourceDocument(a)) ||
          (b.score ?? 0) - (a.score ?? 0));
    }

    // Deduplicate and diversify repeated chunks by canonical document/source.
    // The ordered candidates retain pinned FMR/DoDI priority, while the
    // distinct-source pass ensures mixed legal questions can reach both the
    // Law Center and official/general results.
    const proposalPriority = proposalMatches.slice(0, 2);
    const matches = selectDiverseMatches([...trainingAuthorityMatches, ...proposalPriority, ...recoveredCfrMatches, ...rankedMatches], route.legal ? 12 : 10, match => {
      // Preserve two passages of this single document, not two independent
      // authorities. Public source URLs and source counts remain canonical.
      if (proposalPriority.some(candidate => candidate.id === match.id)) return `proposal-passage:${match.id}`;
      if (trainingAuthorityMatches.some(candidate => candidate.id === match.id)) return `training-definition:${match.id}`;
      if (isDodFmrVolume7aMatch(match)) return normalizeSourceUrl(dodFmrVolume7aUrl);
      if (isDodi133601Match(match)) return normalizeSourceUrl(dodi133601Url);
      return sourceDocumentKey(match);
    }, [...trainingAuthorityMatches, ...proposalPriority, ...veteranDefinitionMatches.slice(0, 3), ...recoveredCfrMatches, ...focusedMatches,
      ...(route.legal && !lawCenterOnly ? generalCandidates.slice(0, 1) : [])]);

    const relevantMatches = matches;

    // 4. Check pinned sections — directly fetch chunks that vector search misses
    const alreadyIncluded = new Set(relevantMatches.map(m => m.id));
    const pinnedChunks = [];

    for (const section of PINNED_SECTIONS) {
      if (!lawCenterOnly && section.pattern.test(question)) {
        const missingIds = section.ids.filter(id => !alreadyIncluded.has(id));
        if (missingIds.length > 0 && retrievalClient.pinecone) {
          const pinnedIndex = retrievalClient.pinecone.index(pineconeIndexName);
          const fetched = await pinnedIndex.fetch(missingIds);
          for (const [id, rec] of Object.entries(fetched.records ?? {})) {
            if (rec?.metadata?.text) {
              pinnedChunks.push({ id, metadata: rec.metadata });
            }
          }
        }
      }
    }

    // Build final context: vector results first, then any pinned additions
    const candidateChunks = [
      ...trainingAuthorityMatches.map(sourceDocument),
      ...veteranDefinitionMatches.map(sourceDocument),
      ...relevantMatches.map(sourceDocument),
      ...pinnedChunks.map(c => ({
        text: c.metadata.text || "",
        url: publicSourceUrl(c.metadata.url || "./jtr.pdf"),
        title: c.metadata.title || "Pinned JTR section",
      })),
    ].filter((chunk, index, chunks) => chunk.text.trim() &&
      chunks.findIndex(other => other.url === chunk.url && other.text === chunk.text) === index);

    // Keep full-index retrieval, but only supply topic-relevant evidence for
    // disability answers. A VA URL or an unrelated high-scoring chunk is not
    // sufficient support for a claim or presumptive-condition answer.
    const ordinaryChunks = vaDisabilityQuestion
      ? preferInjuryRegulations(question,
          preferShoulderSchedule(question, relevantVaDisabilityDocuments(evidenceQuestion, candidateChunks)))
      : candidateChunks;
    const allChunks = [...candidateChunks.filter(chunk =>
      trainingAuthorityKeys.has(`${chunk.url}\n${chunk.text}`)),
      ...candidateChunks.filter(chunk =>
      recoveredCfrKeys.has(`${chunk.url}\n${chunk.text}`)), ...ordinaryChunks]
      .filter((chunk, i, chunks) => chunks.findIndex(other =>
        other.url === chunk.url && other.text === chunk.text) === i);

    const finalContext = (proposalRecoveryFailed
      ? "A targeted indexed-proposal lookup was unavailable. This is not evidence that the proposal is absent from the RAG. Explain what the supplied passages establish without claiming a complete index search.\n\n"
      : "") + allChunks
      .map(sourceContext)
      .join("\n\n---\n\n");

    const allSourceUrls = [
      ...new Map(
        allChunks
          .map(c => c.url)
          .filter(Boolean)
          .map(url => [normalizeSourceUrl(url), url])
      ).values(),
    ];
    const finalSources = allSourceUrls;
    const retrievedAuthorityFamilies = Object.fromEntries(
      mixedFamilies.map(family => [family, relevantMatches.some(match =>
        match.id === focusedByFamily[family]?.id)
        ? [publicSourceUrl(recordUrl(focusedByFamily[family]))] : []]),
    );

    if (allChunks.length === 0) {
      return { status: "no_match", context: null, retrieval: {
        category: route.key, chatMode, selectedChunks: 0,
        vaDisabilityEvidence: false,
      } };
    }

    return {
      context: finalContext,
      sources: finalSources,
      sourceDocuments: allChunks,
      retrieval: {
        category: route.key,
        chatMode,
        payPolicyQuery,
        dd214PathwayQuery,
        dd214PolicyQuery,
        lawReviewPrioritized: route.legal,
        lawCenterOnly,
        generalMatches: generalMatches.length,
        lawReviewQueryMatches: lawMatches.length,
        lawReviewSourceMatches: relevantMatches.filter(m => isLawReviewUrl(recordUrl(m))).length,
        officialSourceMatches: relevantMatches.filter(m =>
          isDodFmrVolume7aMatch(m) || isOfficialPolicyUrl(sourceDocument(m).url) ||
          isCfrTitle38Source(sourceDocument(m))
        ).length,
        fmrVolume7aMatches: relevantMatches.filter(isDodFmrVolume7aMatch).length,
        dodi133601Matches: relevantMatches.filter(isDodi133601Match).length,
        roaPayMatrixMatches: relevantMatches.filter(isRoaPayMatrixMatch).length,
        selectedChunks: allChunks.length,
        vaDisabilityEvidence: vaDisabilityQuestion,
        cfrRecoveredChunks: recoveredCfrMatches.length,
        proposalRecoveredChunks: proposalMatches.length,
        proposalSelectedChunks: allChunks.filter(doc => doc.legalStatus === "proposal-discussion").length,
        proposalRecoveryFailed,
        cfrRecoveryFailures,
        trainingAuthorityQuery,
        trainingAuthorityRecoveryFailed,
        trainingAuthoritySelectedChunks: allChunks.filter(doc =>
          trainingAuthorityKeys.has(`${doc.url}\n${doc.text}`)).length,
        ...(isShoulderRatingQuestion(question) ? {
          shoulderScheduleEvidence: allChunks.some(isOfficialShoulderSchedule),
        } : {}),
        veteranDefinitionQuery,
        veteranDefinitionAvailable: allChunks.some(document => document.url === VETERAN_DEFINITION_URL),
        retrievedAuthorityFamilies,
      },
    };

  } catch (err) {
    // Errors from providers can include request content; never log the error or question.
    return { status: "unavailable", context: null };
  }
}

// --- Main chat endpoint (streaming SSE) ---
app.post("/api/source-pack", limitRequests(10, 60 * 1000), sourcePackHandler({
  getClient: () => ({
    indexHost: pineconeIndexHost,
    embed: embedQuery,
    fetch: globalThis.fetch,
  }),
}));

app.post("/chat", limitRequests(30, 15 * 60 * 1000), async (req, res) => {
  res.set("Cache-Control", "no-store, private");
  const {
    message: submittedMessage,
    conversationHistory: submittedHistory = [],
    chatMode: requestedChatMode,
    lawCenterOnly = false,
    dd214PathwayState: requestedDd214PathwayState = "not_started",
    conversationState: requestedConversationState,
  } = req.body || {};
  if (typeof submittedMessage !== "string" || !submittedMessage.trim() || submittedMessage.length > 4000) {
    return res.status(400).json({ error: "Please enter a message of up to 4,000 characters." });
  }
  // Sanitize the latest turn AND resubmitted history before classification,
  // retrieval, model requests, or any optional logging.
  const message = redactPII(submittedMessage);
  const conversationHistory = Array.isArray(submittedHistory)
    ? submittedHistory.map(turn => ({
        role: turn?.role,
        content: redactPII(turn?.content),
      }))
    : [];
  const wasRedacted = message !== submittedMessage ||
    conversationHistory.some((turn, index) => turn.content !== submittedHistory[index]?.content);
  const crisisLevel = detectCrisis(message);
  // Keep the existing fail-closed check for identifiers outside the supported
  // redaction patterns (such as account numbers and payment cards). A high
  // crisis request is answered locally, so it must not be blocked by this gate.
  if (crisisLevel !== "high" && (containsObviousPersonalData(message) ||
      conversationHistory.some(entry => containsObviousPersonalData(entry?.content)))) {
    return res.status(422).json({
      error: "Remove account or payment card numbers and other personal identifiers before chatting.",
    });
  }
  const chatMode = normalizeChatMode(requestedChatMode, lawCenterOnly);
  if (!chatMode) {
    return res.status(400).json({
      error: `Invalid chat mode. Expected one of: ${[...VALID_CHAT_MODES].join(", ")}`,
    });
  }
  const isLawCenterOnly = chatMode === "law_center";
  const conversation = readConversationState(requestedConversationState);
  const crisisSessionActive = conversation.crisisActive || crisisLevel === "high";
  const denyingDeparture = !crisisSessionActive &&
    isUserDenyingDeparture(message) && !isUserLeavingService(message);
  const userLeaving = !crisisSessionActive && !denyingDeparture && isUserLeavingService(message);
  if (conversation && denyingDeparture) {
    conversation.transitionEligible = false;
    conversation.intake = newTransitionIntake();
  } else if (conversation && userLeaving) {
    conversation.transitionEligible = true;
  }
  let previousDd214State = resolveDd214State(conversation, requestedDd214PathwayState, conversationHistory);
  let dd214Reply = message;
  if (!crisisSessionActive && previousDd214State === "not_started") {
    const suppliedAwareness = [...conversationHistory.filter(turn => turn.role === "user").map(turn => turn.content), message]
      .map(volunteeredDd214Awareness).filter(value => value !== null).at(-1);
    if (suppliedAwareness !== undefined) {
      conversation.dd214AwarenessAsked = true;
      previousDd214State = suppliedAwareness ? "completed" : "awareness_asked";
      dd214Reply = suppliedAwareness ? "Yes" : "No";
    }
  }
  const dd214PathwayState = denyingDeparture ? "completed" : previousDd214State;
  conversation.dd214PathwayState = dd214PathwayState;

  if (!message) {
    return res.status(400).json({ error: "No message provided" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");

  try {
    if (wasRedacted) {
      res.write(`data: ${JSON.stringify({ type: "redaction", text: message, notice: REDACTION_NOTICE })}\n\n`);
    }
    if (crisisLevel !== "none") {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(), chatbot: "ReserveConnect", level: crisisLevel,
      }));
    }
    if (crisisLevel === "high") {
      conversation.crisisActive = true;
      const harmOthers = isHarmToOthers(message);
      const responseText = harmOthers ? CRISIS_OTHERS_MESSAGE : CRISIS_MESSAGE;
      res.write(`data: ${JSON.stringify({ type: "crisis", text: responseText, harmOthers })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", crisis: true, sources: [], finalText: responseText,
        conversationState: conversation,
      })}\n\n`);
      return res.end();
    }
    if (denyingDeparture && !message.includes("?")) {
      const responseText = "Understood—you are not leaving the military. I will stop the DD Form 214-1 and transition questions. What would you like help with instead?";
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: responseText,
        dd214PathwayState: "completed", transitionIntake: conversation.intake, conversationState: conversation,
      })}\n\n`);
      return res.end();
    }
    // Keep enough context for multi-step pathways such as the 8-question pay intake.
    // Some frontends include the current user message in conversationHistory before
    // sending it, so remove that duplicate before appending the RAG-enriched version.
    const cleanHistory = Array.isArray(conversationHistory)
      ? conversationHistory
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-20)
      : [];

    const lastHistoryMessage = cleanHistory.at(-1);
    if (
      lastHistoryMessage?.role === "user" &&
      lastHistoryMessage.content.trim() === message.trim()
    ) {
      cleanHistory.pop();
    }

    if (!crisisSessionActive && crisisLevel === "none" && isGeneralVaOpening(message)) {
      res.write(`data: ${JSON.stringify({ type: "text", text: VA_OPENING_REPLY })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: VA_OPENING_REPLY,
        conversationState: conversation, dd214PathwayState,
        retrieval: { category: "va", status: "clarification", selectedChunks: 0 },
      })}\n\n`);
      return res.end();
    }
    const veteranQuestion = contextualVeteranQuestion(message, cleanHistory);
    const veteranResearch = isVeteranDefinitionQuestion(veteranQuestion);
    const vaScope = resolveVaDisabilityQuestion(veteranQuestion, cleanHistory);
    const vaQuestion = vaScope.question;
    const requiresVaEvidence = vaScope.requiresEvidence;

    // Verified VA payment rows are selected deterministically, not guessed
    // from a projected COLA or interpreted from a flattened retrieved table.
    if (!crisisSessionActive && !isLawCenterOnly) {
      const compensation = vaCompensationTurn(message, cleanHistory);
      if (compensation) {
        res.write(`data: ${JSON.stringify({ type: "text", text: compensation.text })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "done", sources: compensation.sources, finalText: compensation.text,
          conversationState: conversation, dd214PathwayState,
          retrieval: { category: "va", status: "verified-rate-table", selectedChunks: 0 },
        })}\n\n`);
        return res.end();
      }
    }

    if (!crisisSessionActive) {
      if (!denyingDeparture) conversation.intake =
        rememberTransitionAnswers(conversation.intake, message, cleanHistory);
      conversation.payFacts = rememberPayFacts(conversation.payFacts, message, cleanHistory);
      if (conversation.payFacts.years !== undefined) conversation.serviceYears = conversation.payFacts.years;
    }

    // Home-loan eligibility must use retrieved passages and the independent
    // audit below, not a hardcoded answer claiming live official verification.

    // Q1's B option is training, not the general active-duty mobilization
    // route. Keep these two turns independent of retrieval and model wording.
    const lastAssistant = [...cleanHistory].reverse().find(m => m.role === "assistant");
    const latestAssistant = cleanHistory.at(-1)?.role === "assistant" ? cleanHistory.at(-1) : null;
    const payMode = conversation && !crisisSessionActive &&
      !veteranResearch && !requiresVaEvidence && !isLawCenterOnly && (chatMode === "pay" || chatMode === "general");
    // A newer assistant reply supersedes any pending choice, even if it has
    // no options. An older list in history must not answer a different question.
    const activeChoice = payMode && latestAssistant && letteredPayQuestion(latestAssistant.content)
      ? { question: letteredPayQuestion(latestAssistant.content) } : null;
    const selectedChoice = selectedPayOption(activeChoice?.question, message);
    if (payMode) {
    }
    // The final answer is authoritative when available. History also allows a
    // member to resume a question asked before the server's current session.
    const historyPayQuestion = lastPayQuestion(latestAssistant?.content);
    const awaitingPayQuestion = latestAssistant
      ? (historyPayQuestion || (/please enter your total years of military service/i.test(latestAssistant.content)
        ? conversation.lastPayQuestion : null))
      : conversation?.lastPayQuestion;
    if (!crisisSessionActive && conversation && !conversation.lastPayQuestion && historyPayQuestion) {
      conversation.lastPayQuestion = historyPayQuestion;
    }
    const intake = conversation?.intake;
    const intakeActive = ["q1", "q2", "q3"].includes(intake?.stage);
    const { offPathway: pathwayInterrupted } = pathwayTurn(message, intake?.stage, dd214PathwayState, dd214Reply);
    const offPathway = requiresVaEvidence || denyingDeparture || pathwayInterrupted;
    const payStage = crisisSessionActive || requiresVaEvidence ? null : conversation?.payTraining?.stage;
    if (payMode &&
        awaitingPayQuestion === "yearsOfService") {
      const parsed = parseServiceYears(message);
      // A different question is not an answer to the years prompt; let the
      // normal chat flow handle the diversion instead of consuming this field.
      if (parsed.kind !== "invalid" || /^\s*[\d.+-]/.test(message) ||
          /\b(?:years?|service|skip)\b/i.test(message)) {
        const responseText = parsed.kind === "invalid"
          ? "Please enter your total years of military service as a whole number from 0 to 60 (for example, 7), or say Skip."
          : nextMissingPayQuestion(conversation.payFacts, "dependents");
        if (parsed.kind !== "invalid") {
          conversation.serviceYears = parsed.kind === "years" ? parsed.value : null;
          if (parsed.kind === "years") conversation.payFacts.years = parsed.value;
          conversation.lastPayQuestion = lastPayQuestion(responseText);
        }
        if (responseText) {
          res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done", sources: [], finalText: responseText, conversationState: conversation })}\n\n`);
          return res.end();
        }
      }
    }
    // These steps have an unambiguous next question. Do not ask the model to
    // reinterpret a bare B as a new question or to repeat the dependents prompt.
    const choicePrompt = activeChoice?.question.prompt || "";
    if (selectedChoice && /are you serving CONUS/i.test(choicePrompt)) {
      conversation.payFacts.location = selectedChoice.letter === "A" ? "CONUS" : "OCONUS";
    }
    if (selectedChoice && /do you have any dependents/i.test(choicePrompt)) {
      conversation.payFacts.hasDependents = selectedChoice.letter === "A";
    }
    if (selectedChoice && /are your dependents with you/i.test(choicePrompt)) {
      conversation.payFacts.dependentLocation = selectedChoice.letter === "A" ? "with_member" : "elsewhere";
    }
    const nextPayQuestion = selectedChoice && /do you have any dependents/i.test(choicePrompt) &&
      selectedChoice.letter === "B" ? nextMissingPayQuestion(conversation.payFacts, "other")
      : selectedChoice && /are you serving CONUS/i.test(choicePrompt) ? nextMissingPayQuestion(conversation.payFacts, "years")
      : selectedChoice && /are your dependents with you/i.test(choicePrompt) ? nextMissingPayQuestion(conversation.payFacts, "other")
      : null;
    if (nextPayQuestion) {
      conversation.lastPayQuestion = lastPayQuestion(nextPayQuestion);
      res.write(`data: ${JSON.stringify({ type: "text", text: nextPayQuestion })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", sources: [], finalText: nextPayQuestion, conversationState: conversation })}\n\n`);
      return res.end();
    }
    const choosingTraining = !crisisSessionActive && Boolean(conversation) && !isLawCenterOnly &&
      (chatMode === "pay" || chatMode === "general") &&
      !payStage && isPayDutyStatusQuestion(lastAssistant?.content) &&
      isTrainingChoice(message);
    if (payStage === "confirm" || choosingTraining) {
      let responseText;
      if (choosingTraining) {
        // A plain B means training but does not tell us which kind.
        // The original question may have included an explicit duty type.
        const original = [...cleanHistory].reverse().find(m => m.role === "user");
        const type = conversation.payFacts.trainingType || explicitTrainingType(original?.content);
        conversation.payTraining = type
          ? { stage: "grade", type }
          : { stage: "confirm", type: null };
        responseText = type ? nextMissingPayQuestion(conversation.payFacts) : TRAINING_CONFIRMATION;
      } else {
        const type = trainingType(message);
        if (type) {
          conversation.payTraining = { stage: "grade", type };
          responseText = nextMissingPayQuestion(conversation.payFacts);
        } else if (/^skip\b/i.test(message.trim())) {
          conversation.payTraining = { stage: "grade", type: null };
          responseText = nextMissingPayQuestion(conversation.payFacts);
        } else {
          responseText = `Please choose AT or ADT (or Skip if you don't know).\n\n${TRAINING_CONFIRMATION}`;
        }
      }
      if (conversation.payFacts.grade && conversation.payTraining?.stage === "grade") {
        conversation.payTraining.stage = "later";
      }
      conversation.lastPayQuestion = null;
      if (responseText) {
        conversation.lastPayQuestion = lastPayQuestion(responseText);
        res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done", sources: [], finalText: responseText, conversationState: conversation })}\n\n`);
        return res.end();
      }
    }

    // Use the latest question; add limited context only for short follow-ups.
    const resolvedMessage = selectedChoice ? `${selectedChoice.answer} (option ${selectedChoice.letter})` : message;
    const retrievalQuery = requiresVaEvidence ? vaQuestion
      : veteranQuestion !== message ? veteranQuestion : buildRetrievalQuery(resolvedMessage, cleanHistory, conversation,
      { offPathway, includePayFacts: !crisisSessionActive &&
        (chatMode === "pay" || isPayPolicyQuery(message) ||
          Boolean(conversation?.payTraining || conversation?.lastPayQuestion)) });
    const dd214PathwayTriggered =
      !veteranResearch && !crisisSessionActive && !isLawCenterOnly && !offPathway && conversation?.transitionEligible &&
      dd214PathwayState !== "completed" &&
      (dd214PathwayState !== "not_started" || userLeaving);
    const dd214PolicyQuery =
      !isLawCenterOnly && !denyingDeparture && (dd214PathwayTriggered || isDd214PathwayQuery(message));
    const nextDd214PathwayState = offPathway ? dd214PathwayState :
      advanceDd214PathwayState(dd214PathwayState, dd214Reply, dd214PathwayTriggered);
    conversation.dd214PathwayState = nextDd214PathwayState;
    if (dd214PathwayTriggered &&
        (dd214PathwayState === "not_started" ||
         (dd214PathwayState === "awareness_asked" && nextDd214PathwayState === "awareness_asked"))) {
      const firstAsk = !conversation.dd214AwarenessAsked;
      conversation.dd214AwarenessAsked = true;
      const responseText = firstAsk ? DD214_AWARENESS_QUESTION :
        "You can answer the earlier DD Form 214-1 question in your own words, or ask a different question. We do not need to repeat it.";
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: responseText,
        dd214PathwayState: nextDd214PathwayState,
        conversationState: conversation,
      })}\n\n`);
      return res.end();
    }
    // DD Form 214-1 is mandatory first. An affirmative awareness answer or a
    // declined review starts Q1 immediately; an accepted review gets its DD
    // guidance first and starts Q1 on the following turn.
    const dd214ReviewAccepted = dd214PathwayState === "review_offered" &&
      nextDd214PathwayState === "completed" &&
      /^(?:a(?:\s*$|[).:-]\s*)|yes\b|yeah\b|yep\b|sure\b)/i.test(message.trim());
    const startIntake = intake?.stage === "not_started" &&
      !isLawCenterOnly && !offPathway && conversation?.transitionEligible &&
      nextDd214PathwayState === "completed" && !dd214ReviewAccepted;
    const processIntake = !veteranResearch && !crisisSessionActive && intake && !offPathway && (startIntake || intakeActive);
    const nextIntake = processIntake ? advanceTransitionIntake(intake, message) : intake;
    if (processIntake && nextIntake.stage !== "completed") {
      // No model call can skip, repeat, or re-interpret an intake choice.
      conversation.intake = nextIntake;
      const clarification = nextIntake === intake;
      const responseText = clarification
        ? "If none of those choices fits, you can describe your situation in your own words or ask a different question. You can also say you are not leaving the military to stop these questions."
        : `${TRANSITION_QUESTIONS[nextIntake.stage]}\n\n${TRANSITION_CLOSING}`;
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: responseText,
        dd214PathwayState: nextDd214PathwayState,
        transitionIntake: nextIntake,
        conversationState: conversation,
      })}\n\n`);
      return res.end();
    }

    // Drill amounts are chosen from the saved DFAS rows, never inferred from
    // monthly basic pay or from an older policy chunk.
    const currentYear = new Date().getUTCFullYear();
    if (!requiresVaEvidence && !isLawCenterOnly && !crisisSessionActive) {
      const answer = drillPayTurn(message, conversation.drillPayLookup);
      if (answer) {
        conversation.drillPayLookup = answer.state;
        res.write(`data: ${JSON.stringify({ type: "text", text: answer.text })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "done", sources: answer.sources, finalText: answer.text,
          conversationState: conversation, dd214PathwayState,
        })}\n\n`);
        return res.end();
      }
    }
    if (!requiresVaEvidence && !isLawCenterOnly && !crisisSessionActive) {
      const bahAnswer = bahRateTurn(message, conversation.bahLookup);
      if (bahAnswer) {
        conversation.bahLookup = bahAnswer.state;
        res.write(`data: ${JSON.stringify({ type: "text", text: bahAnswer.text })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "done", sources: bahAnswer.sources, finalText: bahAnswer.text,
          conversationState: conversation, dd214PathwayState,
        })}\n\n`);
        return res.end();
      }
    }
    if (!requiresVaEvidence && !isLawCenterOnly) {
      const allowance = officialAllowanceAnswer(message, currentYear);
      if (allowance) {
        res.write(`data: ${JSON.stringify({ type: "text", text: allowance.text })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "done", sources: allowance.sources, finalText: allowance.text,
          conversationState: conversation, dd214PathwayState,
        })}\n\n`);
        return res.end();
      }
    }
    if (!requiresVaEvidence && !isLawCenterOnly && isCurrentBasRateQuestion(message, currentYear)) {
      const answer = currentBasAnswer(currentYear);
      res.write(`data: ${JSON.stringify({ type: "text", text: answer.text })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: answer.sources, finalText: answer.text,
        conversationState: conversation, dd214PathwayState,
      })}\n\n`);
      return res.end();
    }
    if (!requiresVaEvidence && !isLawCenterOnly && isCurrentIdtTravelCapQuestion(message, currentYear)) {
      const answer = currentIdtTravelCapAnswer(currentYear);
      res.write(`data: ${JSON.stringify({ type: "text", text: answer.text })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: answer.sources, finalText: answer.text,
        conversationState: conversation, dd214PathwayState,
      })}\n\n`);
      return res.end();
    }

    // 1. Search the knowledge base (Voyage embed + Pinecone — runs before streaming starts)
    const kb = await getKnowledgeBaseContext(retrievalQuery, {
      chatMode: offPathway ? "general" : chatMode,
      question: requiresVaEvidence ? vaQuestion : selectedChoice && payMode
        ? `Military pay ${resolvedMessage}` : veteranQuestion,
      evidenceQuestion: requiresVaEvidence ? vaScope.evidenceQuestion : undefined,
      forceDd214Pathway: dd214PathwayTriggered && !offPathway,
      includeDd214Policy: dd214PolicyQuery,
      retrievalClient: app.locals.retrievalClient || undefined,
    });
    const requestedRoute = classifyQuery(message);
    const responseRoute = requiresVaEvidence ? QUERY_ROUTES.find(route => route.key === "va")
      : offPathway ? requestedRoute : routeForMode(chatMode, message);
    if (requiresVaEvidence && !kb?.retrieval?.vaDisabilityEvidence) {
      const responseText = isInjuryResearchQuestion(vaQuestion)
        ? injuryResearchClarification(vaQuestion, kb?.status === "unavailable")
        : kb?.status === "unavailable"
        ? "The source search is temporarily unavailable. I can't answer this disability-benefits question without a verified source. Please try again later or check directly with VA or an accredited VA representative."
        : "I couldn't find a directly relevant source in the available knowledge base. I can't answer this disability-benefits question without source support. Try a more specific question, or check directly with VA or an accredited VA representative.";
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: responseText,
        conversationState: conversation, dd214PathwayState,
        retrieval: kb?.retrieval || { category: "va", status: kb?.status, selectedChunks: 0 },
      })}\n\n`);
      return res.end();
    }
    if (kb?.status === "unavailable" && !isLawCenterOnly) {
      const responseText = "The knowledge base is temporarily unavailable. Please try again later.";
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: responseText,
        conversationState: conversation, dd214PathwayState,
        transitionIntake: conversation.intake,
        retrieval: { category: responseRoute.key, status: "unavailable", selectedChunks: 0 },
      })}\n\n`);
      return res.end();
    }
    if (requiresVaEvidence && needsInjuryResearchIntake(message, cleanHistory)) {
      const finalText = injuryResearchClarification(vaQuestion, false, true);
      res.write(`data: ${JSON.stringify({ type: "text", text: finalText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", finalText, sources: [], conversationState: conversation,
        dd214PathwayState, retrieval: kb.retrieval,
      })}\n\n`);
      return res.end();
    }
    // Explain exact retrieved schedule rows without guessing a personal rating
    // or letting a conflicting secondary summary supply the percentages.
    const limbOverview = limbLossOverview(vaQuestion, kb?.sourceDocuments || []);
    if (requiresVaEvidence && limbOverview) {
      res.write(`data: ${JSON.stringify({ type: "text", text: limbOverview })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", finalText: limbOverview,
        sources: visibleAnswerSources(limbOverview, kb.sourceDocuments),
        conversationState: conversation, dd214PathwayState, retrieval: kb.retrieval,
      })}\n\n`);
      return res.end();
    }
    const shoulderAnswer = shoulderCriteriaAnswer(vaQuestion, kb?.sourceDocuments || []);
    const shoulderOnlyRating = isShoulderMotionCriteriaQuestion(vaQuestion);
    if (requiresVaEvidence && (shoulderAnswer ||
        (shoulderOnlyRating && !kb?.retrieval?.shoulderScheduleEvidence))) {
      const finalText = shoulderAnswer ||
        "I found shoulder-related material, but couldn't verify the applicable percentages from the official rating schedule passages retrieved for this turn. I won't substitute a secondary summary or guess your rating. Please narrow the question to the shoulder condition or diagnostic code, or check with VA or an accredited representative.";
      res.write(`data: ${JSON.stringify({ type: "text", text: finalText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", finalText, sources: shoulderAnswer
          ? visibleAnswerSources(finalText, kb.sourceDocuments) : [],
        conversationState: conversation, dd214PathwayState, retrieval: kb.retrieval,
      })}\n\n`);
      return res.end();
    }
    const veteranClarification = veteranBenefitClarification(
      veteranQuestion, kb?.sourceDocuments || [], cleanHistory,
    );
    if (veteranClarification) {
      res.write(`data: ${JSON.stringify({ type: "text", text: veteranClarification })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", finalText: veteranClarification,
        sources: visibleAnswerSources(veteranClarification, kb.sourceDocuments),
        conversationState: conversation, dd214PathwayState, retrieval: kb.retrieval,
      })}\n\n`);
      return res.end();
    }
    // Never substitute an older FMR rate for a requested current-year figure.
    // This also protects other pay/allowance rates whose live official pages
    // may be inaccessible to this server.
    if (!isLawCenterOnly && isCurrentPayRateQuestion(message, currentYear) &&
        !hasCurrentYearRateEvidence(kb?.sourceDocuments, currentYear)) {
      const responseText = `I can't verify a ${currentYear} rate for that pay or allowance from a current official table. Please check the [DFAS pay tables](https://www.dfas.mil/MilitaryMembers/payentitlements/Pay-Tables/) or your unit finance office for the current amount.`;
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done", sources: [], finalText: responseText,
        conversationState: conversation, dd214PathwayState,
      })}\n\n`);
      return res.end();
    }
    const dd214AffirmativeAnswer =
      /^(?:a(?:\s*$|[).:-]\s*)|yes\b|yeah\b|yep\b|sure\b)/i.test(String(dd214Reply || "").trim());
    const dd214StageDirective = dd214PathwayState === "not_started"
      ? "Ask only the Step 1 awareness question with its A, B, and C options. Do not answer the original transition question or explain DD Form 214-1 yet."
      : dd214PathwayState === "awareness_asked" && nextDd214PathwayState === "completed"
      ? "The user answered Yes to the awareness question. Do not repeat DD Form 214-1 information and do not offer the document review. Exit this pathway and ask only the next unanswered ReserveTransition question."
      : dd214PathwayState === "awareness_asked" && nextDd214PathwayState === "review_offered"
      ? "The user answered No or Not Sure. Give the Step 1 explanation, including the limited issuance rule and delivery timing, then ask only whether they want to review the important DD Form 214-1 information."
      : dd214PathwayState === "review_offered" && nextDd214PathwayState === "completed" && dd214AffirmativeAnswer
      ? "The user accepted the review. Give every required Step 2 Table 2 field, the DoDI 1215.06 activation categories and URL, the correction-before-signing warning, and the exact final DD Form 214/DD Form 214-1 follow-up question."
      : dd214PathwayState === "review_offered" && nextDd214PathwayState === "completed"
      ? "The user declined the review. Do not repeat the DD Form 214-1 explanation. Exit this pathway and ask only the next unanswered ReserveTransition question."
      : "Follow only the next DD Form 214-1 pathway stage.";

    if (
      isLawCenterOnly &&
      (!kb?.context || kb.retrieval?.lawReviewSourceMatches === 0)
    ) {
      const noMatchText = kb?.status === "unavailable"
        ? "The Reserve Service Law Center search is temporarily unavailable. Please try again, or return to the [Full ReserveConnect Navigator](/)."
        : "I couldn't find a matching article in ROA's Reserve Service Law Center collection. Try rephrasing your question, or switch back to the [Full ReserveConnect Navigator](/) to search the complete ReserveConnect knowledge base.";
      const legalClosing = "\n\nFor advice specific to your situation, consult a JAG attorney or accredited VA claims agent.\n\n[LAW_CENTER_BANNER]";
      const responseText = ensureResourceReferrals(noMatchText + legalClosing, message);
      res.write(`data: ${JSON.stringify({ type: "text", text: responseText })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "done",
        sources: [],
        finalText: responseText,
        conversationState: conversation,
        retrieval: kb?.retrieval || {
          category: "legal",
          lawCenterOnly: true,
          lawReviewPrioritized: true,
          generalMatches: 0,
          lawReviewQueryMatches: 0,
          lawReviewSourceMatches: 0,
          officialSourceMatches: 0,
          selectedChunks: 0,
        },
      })}\n\n`);
      return res.end();
    }

    // 2. Build the user message
    let userContent;
    if (kb && kb.context) {
      userContent = isLawCenterOnly
        ? `RESERVE SERVICE LAW CENTER-ONLY SEARCH. Use only the ROA Reserve Service Law Center article titles and content below. Do not use general knowledge or non-Law-Center sources. If the articles do not directly support the requested answer, say that the Reserve Service Law Center articles do not establish it, suggest switching to the full navigator, and include this exact link: [Full ReserveConnect Navigator](/). Whenever you cite or name an article, include that article's full URL from its Source label.\n\n${kb.context}\n\n---\n\nUser question: ${message}`
        : requiresVaEvidence
        ? `VA DISABILITY RESEARCH: Answer the member's current question, not an earlier filing task. Use only the supplied passages for substantive facts, and cite the exact supplied URLs alongside those facts. If a source covers only one cancer, exposure, service category, or time period, do not extend it to all cancers or this member's eligibility. Explain supported points, clearly identify unsupported details, and ask for the missing cancer type or exposure/service facts when relevant. A historical proposal or an older indexed snapshot does not prove current policy. Do not repeat an unsolicited filing checklist.\n\n${kb.context}\n\n---\n\nCurrent member question in context: ${vaQuestion}`
        : kb?.retrieval?.dd214PathwayQuery
        ? `DD FORM 214-1 PATHWAY REQUIREMENT: Follow the staged DD Form 214-1 pathway in the system instructions before the general transition intake. The current pathway state is "${dd214PathwayState}". ${dd214StageDirective} Use DoDI 1336.01 as the controlling source for issuance, delivery, and Table 2. Use ${dodi121506Url} when explaining which active-duty and full-time National Guard duty activations must be recorded. Ask only the next required question; do not skip ahead.\n\nHere is relevant content from the ROA knowledge base:\n\n${kb.context}\n\n---\n\nUser question: ${message}`
        : kb?.retrieval?.payPolicyQuery
        ? `PAY SOURCE REQUIREMENT: Use DoD FMR Volume 7A for pay entitlement, eligibility, and when it applies; use the JTR for travel and reimbursement policy. Neither document's historical rate table establishes the current annual amount. For current dollar rates use a directly relevant, year-identified official DFAS or DoD rate table. A policy cap or reimbursement ceiling may be sourced to the currently applicable FMR or JTR provision, with its units (for example, per trip rather than per month). Do not use or cite the ROA RC Duty Status Benefits Matrix. For BAH on orders of 30 days or fewer, do not state a rate until contingency-operation status is known. A non-contingency 14-day Annual Training order generally receives BAH-RC based on grade and dependency status, not full ZIP-code BAH. A short contingency-operation order generally receives full BAH from day one based on the RC member's primary residence ZIP.\n\nHere is relevant content from the ROA knowledge base:\n\n${kb.context}\n\n---\n\nUser question: ${message}`
        : `Here is relevant content from the ROA knowledge base:\n\n${kb.context}\n\n---\n\nUser question: ${resolvedMessage}`;
    } else {
      userContent = resolvedMessage;
    }

    // A new question must not inherit earlier intake choices as facts. In
    // particular, "A" to the DD 214-1 awareness question is not Q1's "A"
    // (separating before retirement eligibility).
    const messages = [
      ...(offPathway && !requiresVaEvidence ? [] : cleanHistory),
      { role: "user", content: userContent },
    ];

    // 3. Stream Claude's response token-by-token. If the provider reaches its
    // hard token limit, continue from the partial answer rather than leaving a
    // sentence unfinished.
    const maxTokens = isLawCenterOnly
      ? (config.lawCenterMaxTokens ?? 1200)
      : responseRoute.legal
      ? (config.legalMaxTokens ?? 700)
      : config.maxTokens;
    const modeInstruction = offPathway ? "" : config.chatModes[chatMode]?.instruction;
    const lawCenterLeaseDirective = isLawCenterOnly && isLeaseRightsQuestion(message)
      ? " For a lease cancellation question, do not assume that receiving 'mob orders' by itself establishes SCRA eligibility. Explain that qualifying orders and the timing of the lease matter; ask the member to confirm their duty authority, duration, purpose, and whether the lease predates service or is followed by qualifying PCS or deployment orders. Ground specific rights and notice steps in matching supplied Law Center articles, and cite those articles."
      : "";
    // Leave the specialized pay, DD 214-1, intake, SCRA, and article-only
    // instructions alone. Ordinary answers need space for verified citations,
    // required referrals and the legal closing within the beta word limit.
    const conciseOrdinaryAnswer = !isLawCenterOnly && responseRoute.key !== "pay" &&
      chatMode !== "pay" && !kb?.retrieval?.payPolicyQuery &&
      !kb?.retrieval?.dd214PathwayQuery && !processIntake &&
      dd214PathwayState === "not_started" && !userLeaving && !isScraQuestion(message);
    const citationInstruction = conciseOrdinaryAnswer
      ? "\n\nFor substantive answers, link the strongest directly relevant supplied source beside each claim it supports. Cite distinct documents only when they support distinct claims; there is no minimum number of citations. Never add an unrelated source to reach a quota, invent a link, or imply an uncited answer was verified. Intake questions and acknowledgements do not require citations."
      : "\n\nFor substantive answers, link to the strongest directly relevant supplied sources next to the claims they support. If at least three distinct supplied documents support the answer, include links to three main sources. If fewer support it, cite only those; never pad to three, invent a link, or imply that an uncited answer was verified. Intake questions and acknowledgements do not require citations.";
    const conciseInstruction = conciseOrdinaryAnswer
      ? "\n\nORDINARY ANSWER LENGTH: Answer the question first. Keep your own response to about 110–140 words, including Markdown citations; leave room for any required program referrals, legal closing, and source attribution in the final answer (230 words maximum). For a broad question, give only the most relevant 2–3 points and one focused follow-up question instead of a catalog of options. For multiple topics, use one short sentence per topic. Do not omit a verified source for a factual claim just to meet the budget; shorten explanations, headings and repetition instead. Do not add a separate sources list."
      : "";
    const noSourceInstruction = kb?.status === "no_match"
      ? veteranResearch
        ? "\n\nVETERAN RESEARCH SAFETY: Do not invent a legal test, service threshold or personal eligibility conclusion. Ask the next missing service fact, or help the member identify the specific rule or record VA or an accredited representative needs to confirm. Do not narrate retrieval, missing articles or index coverage."
        : "\n\nNO KNOWLEDGE-BASE MATCH: No ROA source material was found for this question. Say plainly that you could not find a verified ROA source. Do not state specific figures, dollar amounts, dates, eligibility thresholds, statute or regulation section numbers, or policy rules as fact. If helpful, give only general orientation, explicitly labeled general and unverified. Suggest the appropriate official place to confirm (such as DFAS, TRICARE, VA, the member's unit, or JAG), and invite the user to rephrase the question. Do not imply that an answer was verified by the knowledge base."
      : "";
    const systemPrompt = isLawCenterOnly
      ? `${config.systemPrompt}\n\nRESERVE SERVICE LAW CENTER-ONLY MODE: This answer is an article search, not a general legal answer. Ground every substantive statement in the supplied ROA Reserve Service Law Center article titles and content. Identify the relevant article topic naturally. Include the full article URL every time you cite or name an article. If the supplied articles are insufficient, say so instead of filling gaps from general knowledge, suggest switching back to the complete navigator, and include the exact link [Full ReserveConnect Navigator](/). Finish every sentence and conclude cleanly.${lawCenterLeaseDirective}`
      : dd214PathwayState === "completed"
      ? `${config.systemPrompt}\n\n${modeInstruction}\n\nDD FORM 214-1 PATHWAY STATE OVERRIDE: This conversation has already completed or declined the DD Form 214-1 pathway. Do not restart it, even if the current message mentions transition, separation, retirement, discharge, leaving service, or DD Form 214. Continue with the user's current question or the general ReserveTransition intake instead.`
      : `${config.systemPrompt}${modeInstruction ? `\n\n${modeInstruction}` : ""}\n\nSOURCE CITATION REQUIREMENT: Use only the supplied Source labels for citations. When an answer addresses multiple distinct issues or relies on multiple authorities, cite each relevant distinct document by its full URL alongside the claim it supports. Do not cite a source merely because it appears in context, and never invent a URL or attribute a claim to a document that does not support it.`;
    const payTrainingDirective = !crisisSessionActive && payStage === "grade"
      ? `\n\nPAY TRAINING ROUTE: The member selected Q1 B and confirmed ${conversation.payTraining.type || "AT/ADT unknown"}. Q2 (order length and mobilization authority) is skipped for this route. The previous question was Q3 pay grade. Accept this answer and continue with the next unanswered pay question, skipping all facts already supplied. Do not ask order length, contingency status, or mobilization authority yet. Gather missing BAH facts later during BAH determination.`
      : "";
    const confirmedYearsDirective = !crisisSessionActive && conversation?.serviceYears !== undefined
      ? `\n\nPAY INTAKE CONFIRMED: The member answered ${conversation.serviceYears ?? "Skip"} to years of service. Do not ask for or confirm years again; continue from the most recently asked pay question. This number is not order length or pay grade.`
      : "";
    const payChoiceDirective = !crisisSessionActive && selectedChoice
      ? `\n\nPAY INTAKE CHOICE CONFIRMED: The member selected ${selectedChoice.letter}) ${selectedChoice.answer} for the most recent pay question. Record that answer and move to the next applicable pay intake question. Do not repeat the answered question or reinterpret this as an older choice.`
      : "";
    const intakeDirective = !crisisSessionActive && nextIntake?.stage === "completed" && !offPathway
      ? `\n\n${transitionGuidance(nextIntake)}`
      : "";
    const diversionDirective = offPathway
      ? "\n\nCURRENT USER REQUEST TAKES PRIORITY: Answer the user's latest message directly. Do not ask or repeat DD Form 214-1 awareness questions or transition intake options. The user may pause or leave any question pathway. If they say they are not leaving the military, acknowledge the correction and do not assume a separation."
      : "";
    const system = cachedSystemBlocks(
      config.systemPrompt,
      systemPrompt.slice(config.systemPrompt.length) + citationInstruction +
        (requiresVaEvidence
          ? "\n\nVA CITATION FORMAT: For each substantive benefit explanation, cite its supplied numbered source using [[SOURCE:1]], [[SOURCE:2]], etc., matching the [Source N: ...] headers. Do not guess or retype URLs. The server replaces these markers with the actual retrieved source links. Use only sources that establish the statement; a source number is not itself proof. Give a short sourced overview before asking one genuinely missing follow-up question."
          : "") +
        conciseInstruction + noSourceInstruction + intakeDirective +
        veteranGuidanceInstruction(veteranQuestion, kb?.sourceDocuments || [], cleanHistory) +
        trainingAuthorityInstruction(`${veteranQuestion}\n${vaQuestion}`, kb?.sourceDocuments || []) +
        payTrainingDirective + confirmedYearsDirective + payChoiceDirective +
        diversionDirective +
        (!crisisSessionActive && Object.keys(conversation.payFacts).length
          ? `\n\nVOLUNTEERED PAY FACTS (member-supplied, not proof of eligibility): ${JSON.stringify(conversation.payFacts)}. Do not ask these fields again. Ask only genuinely missing inputs for the current pathway.`
          : "") +
        (conversation.dd214AwarenessAsked
          ? "\n\nDD FORM 214-1 AWARENESS ALREADY ASKED: Never ask whether this member knows about DD Form 214-1 again in this conversation, including after topic or Search Mode changes. Do not repeat its awareness question or answer options. You may answer their DD Form 214-1 questions and continue an accepted review."
          : "") +
        (crisisSessionActive
          ? "\n\nCRISIS SESSION: Do not start or resume transition or pay intake, offer promotional prompts, or invite the member to sign up. Answer the current safe question directly."
          : ""),
    );
    let streamedText = "";
    const restrictSupplementalLinks = requiresVaEvidence || kb?.retrieval?.veteranDefinitionQuery ||
      isScraQuestion(message) || conversation.dd214AwarenessAsked;
    // Buffer generated text until formatting and applicable citation-link
    // checks finish. There is no separate AI claim-by-claim response gate.
    const bufferScra = true;
    let stopReason = null;
    let generationMessages = messages;
    const maxGenerationAttempts = isLawCenterOnly ? 3 : 1;

    for (let attempt = 0; attempt < maxGenerationAttempts; attempt += 1) {
      stopReason = null;
      const stream = anthropic.messages.stream({
        model: config.claudeModel || "claude-sonnet-5",
        max_tokens: maxTokens,
        // Sonnet 5 otherwise enables adaptive thinking by default, which
        // would consume the chatbot's small answer-token budget.
        thinking: { type: "disabled" },
        system,
        messages: generationMessages,
      });

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          streamedText += chunk.delta.text;
          if (!bufferScra) res.write(`data: ${JSON.stringify({ type: "text", text: chunk.delta.text })}\n\n`);
        } else if (chunk.type === "message_delta" && chunk.delta?.stop_reason) {
          stopReason = chunk.delta.stop_reason;
        }
      }

      if (stopReason !== "max_tokens") break;
      generationMessages = [
        ...messages,
        { role: "assistant", content: streamedText },
        {
          role: "user",
          content: "Continue exactly where the previous response stopped. Do not repeat prior text. Finish the current sentence and conclude the answer cleanly.",
        },
      ];
    }

    const trainingCitations = (kb?.retrieval?.trainingAuthoritySelectedChunks || 0) > 0;
    const citationMarkers = requiresVaEvidence || trainingCitations
      ? resolveVaCitationMarkers(trainingCitations
          ? normalizeTrainingCitationLists(streamedText) : streamedText, kb?.sourceDocuments || [])
      : { text: streamedText, unresolved: false };
    streamedText = citationMarkers.text;
    const vaDraftCitations = requiresVaEvidence
      ? validateVaCitationLinks(streamedText, kb?.sourceDocuments || []) : null;
    const vaClarificationOnly = requiresVaEvidence &&
      isSafeInjuryClarification(streamedText);
    streamedText = finalizeScraAnswer(ensureCompleteAnswer(correctDd214IssuanceClaims(streamedText)), message, {
      lawCenterOnly: isLawCenterOnly,
      sourceDocuments: kb?.sourceDocuments || [],
    });
    if (!crisisSessionActive && nextIntake?.stage === "completed" && !streamedText.includes(TRANSITION_CLOSING)) {
      streamedText += `\n\n${TRANSITION_CLOSING}`;
      if (!bufferScra) res.write(`data: ${JSON.stringify({ type: "text", text: `\n\n${TRANSITION_CLOSING}` })}\n\n`);
    }

    // Legal safety and Law Center visibility are required behavior, not optional
    // model style. Add either item if the generated answer omitted it.
    if (responseRoute.legal || isLawCenterOnly) {
      let requiredClosing = "";
      if (!/For advice specific to your situation/i.test(streamedText)) {
        requiredClosing += "\n\nFor advice specific to your situation, consult a JAG attorney or accredited VA claims agent.";
      }
      if (!/\[LAW_CENTER_BANNER\]/.test(streamedText)) {
        requiredClosing += "\n\n[LAW_CENTER_BANNER]";
      }
      if (requiredClosing) {
        streamedText += requiredClosing;
        if (!bufferScra) res.write(`data: ${JSON.stringify({ type: "text", text: requiredClosing })}\n\n`);
      }
    }

    const deterministicAttribution = requiresVaEvidence || isLawCenterOnly || streamedText.startsWith("I can't verify the SCRA citation") ||
      streamedText.startsWith("Under [50 U.S.C. § 3955]") || streamedText.startsWith("The supplied Reserve Service Law Center articles do not establish")
      ? ""
      : sourceAttribution(message, kb?.sourceDocuments || [], streamedText);
    if (deterministicAttribution && !streamedText.includes(deterministicAttribution.trim())) {
      streamedText += deterministicAttribution;
      if (!bufferScra) {
        res.write(`data: ${JSON.stringify({ type: "text", text: deterministicAttribution })}\n\n`);
      }
    }

    const extraLinks = conciseOrdinaryAnswer || restrictSupplementalLinks || /\b(?:can't verify|cannot verify|do not establish|does not establish|insufficient)\b/i.test(streamedText)
      ? ""
      : supplementalSourceLinks(message, streamedText, kb?.sourceDocuments || []);
    if (extraLinks) {
      streamedText += extraLinks;
      if (!bufferScra) res.write(`data: ${JSON.stringify({ type: "text", text: extraLinks })}\n\n`);
    }

    // The terminal event is authoritative for clients: enforce referrals after
    // safety corrections, legal closings, and source attribution are finalized.
    if (!crisisSessionActive) streamedText = ensureResourceReferrals(streamedText, message);
    if (crisisLevel === "informational" && !streamedText.includes(INFORMATIONAL_FOOTER)) {
      const footer = `\n\n${INFORMATIONAL_FOOTER}`;
      streamedText += footer;
      if (!bufferScra) res.write(`data: ${JSON.stringify({ type: "text", text: footer })}\n\n`);
    }
    if (!crisisSessionActive && (chatMode === "pay" || chatMode === "general")) {
      conversation.lastPayQuestion = lastPayQuestion(streamedText);
    }

    // Do not expose a wrong citation in partial SSE text while it is being
    // generated. For SCRA questions, send only the checked canonical answer.
    if (conversation.dd214AwarenessAsked) {
      streamedText = removeRepeatedDd214Awareness(streamedText) ||
        "We have already covered the DD Form 214-1 awareness question. What would you like help with next?";
    }
    streamedText = formatServiceCharacterizationQuestions(
      streamedText.replace(/\[LAW_CENTER_BANNER\]/g, "").trim(),
    );
    // Do not display even a partial disability answer without a citation to
    // evidence actually retrieved for this turn.
    if (requiresVaEvidence && !vaClarificationOnly &&
        (citationMarkers.unresolved || !vaDraftCitations?.hasRetrievedCitation || vaDraftCitations.hasUnknownCitation ||
          !validateVaCitationLinks(streamedText, kb?.sourceDocuments || []).hasRetrievedCitation)) {
      streamedText = isInjuryResearchQuestion(vaQuestion)
        ? injuryResearchClarification(vaQuestion, false, true, true)
        : "I found potentially relevant material, but couldn't produce a source-supported answer to your disability-benefits question. Please narrow the question or check with VA or an accredited VA representative.";
    }
    // The owner removed the separate AI claim-by-claim gate. Retrieval,
    // citation-link checks, source-scoped instructions, and buffering remain;
    // a recognized citation is not a certification that every claim is correct.
    if (bufferScra) res.write(`data: ${JSON.stringify({ type: "text", text: streamedText })}\n\n`);

    // 4. Send sources + done signal
    if (processIntake) conversation.intake = nextIntake;
    if (payStage === "grade") conversation.payTraining = { ...conversation.payTraining, stage: "later" };
    const attributionUrls = [...deterministicAttribution.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(match => match[1]);
    const sources = visibleAnswerSources(streamedText, kb?.sourceDocuments || [], attributionUrls);
    res.write(`data: ${JSON.stringify({
      type: "done",
      sources,
      finalText: streamedText,
      dd214PathwayState: nextDd214PathwayState,
      transitionIntake: conversation.intake,
      conversationState: conversation,
      retrieval: kb?.retrieval || {
        category: responseRoute.key,
        chatMode,
        lawReviewPrioritized: responseRoute.legal,
        lawCenterOnly: isLawCenterOnly,
        generalMatches: 0,
        lawReviewQueryMatches: 0,
        lawReviewSourceMatches: 0,
        officialSourceMatches: 0,
        selectedChunks: 0,
      },
    })}\n\n`);
    res.end();

  } catch (err) {
    // SDK errors can include request contents. Never print them to logs.
    res.write(`data: ${JSON.stringify({ type: "error", message: chatFailureMessage(err) })}\n\n`);
    res.end();
  }
});

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({
    status: "ROA Chatbot backend is running ✅",
    knowledgeBase: pineconeIndexHost ? "connected" : "not configured",
  });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;

if (isMainModule) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 ROA Chatbot backend running on port ${PORT}`);
    console.log(`💬 Chat endpoint: POST /chat`);
    console.log(`❤️  Health check: GET /health\n`);
  });
}

export {
  embedQuery,
  chatFailureMessage,
  app,
  classifyQuery,
  getKnowledgeBaseContext,
  ensureCompleteAnswer,
  isBahQuery,
  isDd214PathwayQuery,
  isUserLeavingService,
  isUserDenyingDeparture,
  pathwayTurn,
  visibleAnswerSources,
  advanceDd214PathwayState,
  correctDd214IssuanceClaims,
  isPayPolicyQuery,
  isLawReviewUrl,
  isRoaPayMatrixMatch,
  normalizeChatMode,
  routeForMode,
  normalizeLawCenterName,
  trimToLastCompleteSentence,
  selectDiverseMatches,
  publicSourceUrl,
  sourceDocument,
  sourceAttribution,
  supplementalSourceLinks,
};
