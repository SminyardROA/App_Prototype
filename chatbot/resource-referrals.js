// Referral links are checked against the member's question, not against topics
// introduced by retrieved documents or the model's own answer.
const links = {
  sparta: "https://spartapride.org/",
  out: "https://www.outinnationalsecurity.org/",
  law: "https://roa.org/lawcenter/",
  gig: "https://gigeagle.mil/",
  education: "https://roa.org/reserveeducation/",
  care: "https://www.roainsure.com",
};

function hasLink(answer, url) {
  const target = new URL(url);
  const normalized = value => {
    try {
      const parsed = new URL(value);
      return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
    } catch {
      return "";
    }
  };
  const wanted = normalized(target.href);
  return [...answer.matchAll(/https?:\/\/[^\s<>)\]]+/gi)].some(([match]) =>
    normalized(match.replace(/[.,;!?]+$/, "")) === wanted
  );
}

export function referralTopics(question) {
  const q = String(question || "");
  const lgbtq = /(?:\blgbtq?\b\+?|\b(?:gay|lesbian|queer|bisexual|transgender|trans|sexual orientation|gender identity)\b)/i.test(q) &&
    /\b(?:military|service\s?members?|veterans?|reservists?|reserve|guard|army|navy|air force|marines?|coast guard|dod|duty|discharge|separat\w*|serving)\b/i.test(q);
  // "Gender transition" and medical transition are not military separation.
  const militaryTransition = /\b(?:transition(?:ing)?\s+(?:out of|from|off|away from)\s+(?:the\s+|my\s+)?(?:military|service|guard|reserve|active duty)|(?:military|service|guard|reserve|career)\s+transition)\b/i.test(q);
  const adverse = lgbtq && (/\b(?:separat\w*|discharg\w*|forced out|adverse action|administrative action|retaliat\w*|discriminat\w*)\b/i.test(q) || militaryTransition);
  const workplaceDispute = /\b(?:employer|boss|supervisor|workplace|company)\b.{0,110}\b(?:denied|fired|rights|leave|disput\w*|violat\w*|sued)\b|\b(?:denied|fired|rights|leave|disput\w*|violat\w*|sued)\b.{0,110}\b(?:employer|boss|supervisor|workplace|company)\b/i.test(q);
  const explicitGig = /\b(?:gig work|side (?:gig|job|work)|flexible (?:work|job|employment)|part.time (?:work|job)|extra (?:military )?(?:work|income)|active.duty tours?|military.friendly (?:jobs?|employers?))\b/i.test(q);
  const workRequest = /\b(?:jobs?|employment|work)\b/i.test(q) &&
    /\b(?:reservists?|reserve|guard|military|service\s?members?|drill)\b/i.test(q) &&
    /\b(?:what|where|how|available|options?|opportunities|need|seeking|find|finding|looking|searching|compatible|works? with|around)\b/i.test(q) &&
    !/\b(?:employment rights|job rights|legal rights|wrongful|discrimination)\b/i.test(q);
  const gig = explicitGig || (!workplaceDispute && (workRequest ||
    /\b(?:(?:jobs?|(?:civilian )?employment|work) (?:around|compatible with) (?:drill|reserve)|employment opportunities|(?:find|finding|looking for|searching for) (?:a |some )?(?:job|work|employment|income|gig|active.duty tour))\b/i.test(q)));
  const education = /\b(?:education|college|university|GI Bill|scholarships?|school|tuition|academic|MBA|graduate studies|tutoring)\b/i.test(q);
  const care = /\b(?:health care|healthcare|health insurance|life insurance|dental|vision|coverage|insurance|tricare)\b/i.test(q);
  return { lgbtq, adverse, gig, education, care };
}

export function ensureResourceReferrals(answer, question) {
  const topics = referralTopics(question);
  const additions = [];
  if (topics.lgbtq) {
    if (!hasLink(answer, links.sparta)) additions.push(`Sparta PRIDE (${links.sparta}) supports LGBTQ service members and their families.`);
    if (!hasLink(answer, links.out)) additions.push(`Out in National Security (${links.out}) is a professional network for LGBTQ people in national security and defense.`);
  }
  if (topics.adverse) {
    if (!hasLink(answer, links.law)) additions.push(`For military separation or adverse-action legal help, visit the [Reserve Service Law Center](${links.law}); its attorneys can assist with separation cases.`);
    if (!/\[LAW_CENTER_BANNER\]/.test(answer)) additions.push("[LAW_CENTER_BANNER]");
    if (!/\bJAG\b|military legal assistance attorney/i.test(answer)) additions.push("Consult a JAG attorney about the current policy and your specific situation.");
    if (!/look up.{0,90}DoD instruction.{0,100}service.{0,30}separation regulation/is.test(answer)) {
      additions.push("I can also look up the applicable DoD instruction and your service's separation regulation — would you like me to pull that information?");
    }
  }
  if (topics.gig && !hasLink(answer, links.gig)) {
    additions.push(`The GigEagle program connects reservists with military-friendly employers offering flexible work around drill weekends and annual training. Learn more at ${links.gig}`);
  }
  if (topics.education && !hasLink(answer, links.education)) {
    additions.push(`Visit ROA's ReserveEducation page for scholarships, academic partners, and research at ${links.education}`);
  }
  if (topics.care && !hasLink(answer, links.care)) {
    additions.push(`Are you aware of ROA-sponsored insurance plans — ReserveCare — at ${links.care} ? ReserveCare offers medical insurance, dental and vision insurance, and life insurance options.`);
  }
  if (!additions.length) return answer;
  // Keep the existing Law Center banner last even when other topics overlap.
  const banner = /\[LAW_CENTER_BANNER\]/.test(answer) || additions.includes("[LAW_CENTER_BANNER]");
  const body = answer.replace(/\s*\[LAW_CENTER_BANNER\]/g, "").trimEnd();
  return `${body}\n\n${additions.filter(item => item !== "[LAW_CENTER_BANNER]").join("\n\n")}${banner ? "\n\n[LAW_CENTER_BANNER]" : ""}`;
}