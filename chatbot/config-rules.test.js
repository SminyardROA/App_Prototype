import test from "node:test";
import { installFixtureVaReviewer } from "./va-review-fixture.js";
installFixtureVaReviewer();
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { ensureResourceReferrals, referralTopics } from "./resource-referrals.js";
import {
  classifyQuery,
  advanceDd214PathwayState,
  correctDd214IssuanceClaims,
  isBahQuery,
  isDd214PathwayQuery,
  isUserLeavingService,
  pathwayTurn,
  isPayPolicyQuery,
  isRoaPayMatrixMatch,
} from "./server.js";
import {
  TRANSITION_QUESTIONS,
  newTransitionIntake,
  parseTransitionAnswer,
  advanceTransitionIntake,
  transitionGuidance,
} from "./transition-intake.js";
import {
  lastPayQuestion, parseServiceYears, PAY_DEPENDENTS_QUESTION, PAY_YEARS_QUESTION,
  PAY_OTHER_CIRCUMSTANCES_QUESTION, letteredPayQuestion, selectedPayOption,
} from "./pay-training-intake.js";

function sourceFixtureClient() {
  return {
    indexHost: "fixture.invalid",
    embed: async () => [0.1],
    fetch: async () => ({
      ok: true,
      json: async () => ({ matches: [{
        id: "fixture", score: 0.9,
        metadata: { url: "https://roa.org/member-resources",
          title: "ROA member resources", text: "Reserve member benefits and assistance." },
      }] }),
    }),
  };
}

// Keep the prompt instructions aligned with the server's final-answer checks.
function promptRule(start, end) {
  const first = config.systemPrompt.indexOf(start);
  const last = config.systemPrompt.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing or reordered prompt rule: ${start}`);
  return config.systemPrompt.slice(first, last);
}

test("unsupported SCRA details point to the official chapter without claiming a live statutory check", () => {
  const legal = promptRule("LEGAL QUESTION HANDLING", "LEGAL TOPIC COVERAGE");
  assert.match(legal, /SCRA residential lease termination is 50 U\.S\.C\. § 3955/);
  assert.match(legal, /Title 32 § 502\(f\) service can qualify/);
  assert.match(legal, /For any other SCRA question not addressed by a matching Reserve Service Law Center article or ingested source/);
  assert.ok(legal.includes("https://uscode.house.gov/view.xhtml?path=/prelim@title50/chapter50&edition=prelim"));
  assert.match(legal, /Do not invent a provision, treat this index as proof of a specific rule, or claim to have checked a live section that was not retrieved/);
  assert.match(legal, /In Law Center-only mode, keep the existing Law Center-only source restriction/);
  assert.match(legal, /including residential leases and interest rates/);
  assert.match(legal, /chapter index is an additional reference, not a substitute for a supported section-level citation/);
});

test("LGBTQ referrals are scoped to LGBTQ military topics, not general separation", () => {
  const resources = promptRule("LGBTQ RESOURCES PATHWAY", "LGBTQ SEPARATION PATHWAY");
  assert.match(resources, /Apply when .*gay, lesbian, queer, bisexual, transgender, or LGBTQ in the context of military service/i);
  for (const required of ["Sparta PRIDE", "https://spartapride.org/", "Out in National Security", "https://www.outinnationalsecurity.org/"]) {
    assert.ok(resources.includes(required), required);
  }
  assert.match(resources, /once per response/i);
  assert.doesNotMatch(resources, /LAW_CENTER_BANNER/);

  const separation = promptRule("LGBTQ SEPARATION PATHWAY", "ROA GIGEAGLE AWARENESS");
  assert.match(separation, /LGBTQ-related terms .* alongside separation, discharge, transition, being forced out/i);
  assert.match(separation, /adverse action because of their sexual orientation or gender identity/i);
  assert.match(separation, /In addition to the LGBTQ resources above/i);
  assert.match(separation, /\[LAW_CENTER_BANNER\] once at the end/i);
  assert.match(separation, /Reserve Service Law Center has attorneys/i);
  assert.match(separation, /look up the applicable DoD instruction and your service's separation regulation/i);
  assert.match(separation, /verify with a JAG attorney/i);
});

test("GigEagle referral applies to flexible work, not every employment dispute", () => {
  const gig = promptRule("ROA GIGEAGLE AWARENESS", "ROA RESERVEEMPLOYMENT AWARENESS");
  assert.match(gig, /Apply when a user asks about finding active duty tours, employment opportunities, jobs, gig work, flexible employment, civilian employment compatible with reserve service, or how to find extra military work or income/i);
  assert.match(gig, /connects reservists with military-friendly employers offering flexible work/i);
  assert.match(gig, /https:\/\/gigeagle\.mil\//);
  assert.match(gig, /only once per response/i);
  const employment = promptRule("ROA RESERVEEMPLOYMENT AWARENESS", "ROA RESERVEFAMILIES AWARENESS");
  assert.match(employment, /questions broader than gig work or flexible side work/i);
  assert.match(employment, /GigEagle's lane/i);
});

test("ReserveEducation referral covers academic benefits without becoming a universal referral", () => {
  const education = promptRule("ROA EDUCATION AWARENESS", "ROA INSURANCE AWARENESS");
  assert.match(education, /Apply when a user asks about education,\s+college, university, GI Bill, scholarships, school, tuition, or\s+academic benefits/i);
  assert.match(education, /In every case, include once/i);
  assert.match(education, /ReserveEducation page for\s+scholarships, academic partners, and research at\s+https:\/\/roa\.org\/reserveeducation\//i);
  assert.match(education, /only once per response/i);
  assert.doesNotMatch(education, /roainsure\.com|gigeagle\.mil/);
});

test("ReserveCare referral covers insurance across duty statuses and supplements TRICARE guidance", () => {
  const insurance = promptRule("ROA INSURANCE AWARENESS", "DD FORM 214-1 PATHWAY");
  assert.match(insurance, /Apply when a user asks about health care, health insurance, life insurance, dental insurance, vision insurance, or uses the words "dental," "vision," "coverage," or "insurance"/i);
  assert.match(insurance, /regardless of the user's duty status/i);
  assert.match(insurance, /Are you aware of ROA-sponsored insurance plans — ReserveCare — at https:\/\/www\.roainsure\.com/i);
  assert.match(insurance, /only once per response/i);
  assert.match(insurance, /in addition to, not instead of, any TRICARE-specific guidance/i);
  assert.doesNotMatch(insurance, /reserveeducation|gigeagle/i);
});

test("final answer fills each missing referral, not unrelated referrals", () => {
  const examples = [
    ["As a queer reservist, where can I find support from LGBTQ military organizations?",
      ["spartapride.org", "outinnationalsecurity.org"], ["gigeagle.mil", "reserveeducation", "roainsure.com"]],
    ["What organizations support LGBTQ+ service members?",
      ["spartapride.org", "outinnationalsecurity.org"], ["gigeagle.mil", "reserveeducation", "roainsure.com"]],
    ["Where can a reservist find flexible gig work around drill weekends?",
      ["gigeagle.mil"], ["spartapride.org", "reserveeducation", "roainsure.com"]],
    ["Where can I find civilian employment compatible with reserve service?",
      ["gigeagle.mil"], ["spartapride.org", "reserveeducation", "roainsure.com"]],
    ["What jobs are available for reservists?",
      ["gigeagle.mil"], ["spartapride.org", "reserveeducation", "roainsure.com"]],
    ["Are there any jobs or employment options for Reserve members?",
      ["gigeagle.mil"], ["spartapride.org", "reserveeducation", "roainsure.com"]],
    ["I need civilian employment that works with my Reserve service.",
      ["gigeagle.mil"], ["spartapride.org", "reserveeducation", "roainsure.com"]],
    ["Where can I find GI Bill education benefits and scholarships as a reservist?",
      ["reserveeducation"], ["spartapride.org", "gigeagle.mil", "roainsure.com"]],
    ["What TRICARE health insurance coverage can I get as a drilling reservist?",
      ["roainsure.com"], ["spartapride.org", "gigeagle.mil", "reserveeducation"]],
  ];
  for (const [question, required, excluded] of examples) {
    const answer = ensureResourceReferrals("Here are the options for you.", question);
    for (const link of required) assert.ok(answer.includes(link), `${question}: missing ${link}`);
    for (const link of excluded) assert.ok(!answer.includes(link), `${question}: unrelated ${link}`);
  }
  for (const question of [
    "What are my USERRA rights if my employer fired me after military leave?",
    "What are my legal rights if my employer denied military leave?",
    "What employment rights do reservists have under USERRA?",
    "What GI Bill education benefits can a drilling reservist use?",
  ]) {
    const answer = ensureResourceReferrals("Here is your answer.", question);
    assert.doesNotMatch(answer, /spartapride|outinnationalsecurity|gigeagle|roainsure/i);
  }
  assert.deepEqual(referralTopics("What is my drill pay?"), {
    lgbtq: false, adverse: false, gig: false, education: false, care: false,
  });
  const healthcare = ensureResourceReferrals(
    "Here is information about care.",
    "I'm a transgender Guard member seeking health insurance for gender-transition healthcare."
  );
  assert.match(healthcare, /spartapride\.org/);
  assert.match(healthcare, /roainsure\.com/);
  assert.doesNotMatch(healthcare, /lawcenter|JAG|separation regulation|LAW_CENTER_BANNER/i);
  assert.equal(referralTopics("I'm queer and transitioning out of military service.").adverse, true);
  assert.equal(referralTopics("My employer denied military leave; I also need flexible gig work around drill.").gig, true);
});

test("existing referral links are not repeated, including Markdown and slash variants", () => {
  const question = "I need flexible gig work, GI Bill tuition and dental insurance.";
  const draft = "See [GigEagle](https://gigeagle.mil), [ReserveEducation](https://roa.org/reserveeducation/), and [ReserveCare](https://roainsure.com/).";
  assert.equal(ensureResourceReferrals(draft, question), draft);
  const partial = ensureResourceReferrals("Try [Sparta PRIDE](https://spartapride.org/).", "I'm a transgender Guard member. Where is LGBTQ support?");
  assert.equal((partial.match(/spartapride\.org/g) || []).length, 1);
  assert.equal((partial.match(/outinnationalsecurity\.org/g) || []).length, 1);
  assert.equal(ensureResourceReferrals(partial, "I'm a transgender Guard member. Where is LGBTQ support?"), partial);
});

test("LGBTQ adverse action retains legal escalation alongside all overlapping referrals", () => {
  const question = "I'm transgender and facing adverse action over my gender identity in the Guard. I need legal rights help, flexible gig work, GI Bill education benefits, and health insurance coverage. Where should I start?";
  const draft = "Please review your options with a JAG attorney. [LAW_CENTER_BANNER]";
  const answer = ensureResourceReferrals(draft, question);
  for (const link of ["spartapride.org", "outinnationalsecurity.org", "roa.org/lawcenter/", "gigeagle.mil", "roa.org/reserveeducation/", "roainsure.com"]) {
    assert.equal(answer.split(link).length - 1, 1, link);
  }
  assert.match(answer, /DoD instruction and your service's separation regulation/);
  assert.match(answer, /\[LAW_CENTER_BANNER\]$/);
  assert.equal(answer.split("[LAW_CENTER_BANNER]").length - 1, 1);
  assert.equal(answer.split("JAG attorney").length - 1, 1);
  assert.equal(ensureResourceReferrals(answer, question), answer);
  const missingJAG = ensureResourceReferrals("See [Reserve Service Law Center](https://roa.org/lawcenter/).", question);
  assert.match(missingJAG, /consult a JAG attorney/i);
});

test("chat endpoint publishes required referrals in the terminal SSE answer when the model omits them", async () => {
  const { app } = await import("./server.js");
  const originalStream = Anthropic.Messages.prototype.stream;
  app.locals.retrievalClient = sourceFixtureClient();
  Anthropic.Messages.prototype.stream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Here are some options for you." } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    },
  });
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What jobs are available for reservists?" }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).type, "done");
    assert.match(events.at(-1).finalText, /GigEagle.{0,200}https:\/\/gigeagle\.mil\//);
    assert.doesNotMatch(events.at(-1).finalText, /spartapride|reserveeducation|roainsure/i);
  } finally {
    delete app.locals.retrievalClient;
    Anthropic.Messages.prototype.stream = originalStream;
    await new Promise(resolve => server.close(resolve));
  }
});

test("transition intake recognizes every offered letter and description, without guessing", () => {
  const descriptions = {
    q1: ["I am separating before retirement eligibility", "I am retiring with immediate pay (20+ years, Active Guard/Reserve)", "I am a Grey Area retiree (20+ years Reserve, waiting for age 60)", "I am not sure yet, still exploring my options"],
    q2: ["Within the next 6 months", "6 to 12 months from now", "1 to 2 years from now", "Just researching for now"],
    q3: ["VA disability rating and health benefits", "Health insurance after I leave", "Employment or education after service", "Retirement pay and financial planning", "I want to understand all my options"],
  };
  for (const [stage, choices] of Object.entries(descriptions)) {
    choices.forEach((description, i) => {
      const letter = String.fromCharCode(65 + i);
      for (const answer of [letter, `${letter}) ${description}`, description]) {
        assert.equal(parseTransitionAnswer(stage, answer), letter, `${stage}: ${answer}`);
      }
      assert.match(TRANSITION_QUESTIONS[stage], new RegExp(`${letter}\\)`, "i"));
    });
  }
  for (const [stage, unclear] of Object.entries({
    q1: ["A or B", "I don't know", "A) retiring with immediate pay", "separating before retirement but also Grey Area"],
    q2: ["B or C", "next year maybe", "E", "A) 1 to 2 years"],
    q3: ["A and B", "not sure", "F", "B) employment or education"],
  })) {
    for (const message of unclear) assert.equal(parseTransitionAnswer(stage, message), null, `${stage}: ${message}`);
  }
});

test("every transition answer path advances exactly one stage and retains all answers", () => {
  for (const q1 of ["A", "B", "C", "D"]) {
    for (const q2 of ["A", "B", "C", "D"]) {
      for (const q3 of ["A", "B", "C", "D", "E"]) {
        let state = newTransitionIntake();
        state = advanceTransitionIntake(state, "I am transitioning");
        assert.deepEqual(state, { stage: "q1", answers: { q1: null, q2: null, q3: null } });
        for (const [stage, answer, next] of [
          ["q1", q1, "q2"], ["q2", q2, "q3"], ["q3", q3, "completed"],
        ]) {
          const unchanged = advanceTransitionIntake(state, "A or B");
          assert.equal(unchanged, state, `${stage} must retain progress on ambiguity`);
          state = advanceTransitionIntake(state, answer);
          assert.equal(state.stage, next);
          assert.equal(state.answers[stage], answer);
        }
        assert.deepEqual(state.answers, { q1, q2, q3 });
        assert.equal(advanceTransitionIntake(state, "A"), state, "completion cannot restart");
        const guidance = transitionGuidance(state);
        assert.match(guidance, new RegExp(`Q1=${q1}, Q2=${q2}, Q3=${q3}`));
        assert.match(guidance, {
          A: /120-day SGLI/,
          B: /retirement orders and DFAS/,
          C: /TRICARE Retired Reserve/,
          D: /ask which sounds closest/,
        }[q1]);
      }
    }
  }
});

test("DD Form 214-1 starts only for a user saying they are leaving, not the bot or mode", () => {
  for (const message of [
    "I am transitioning out.", "I am separating.", "I am retiring.",
    "I am leaving my Reserve Component.", "I am being discharged.",
    "I am getting out.", "My separation date is next month.",
  ]) assert.equal(isUserLeavingService(message), true, message);
  for (const message of [
    "I am not separating.", "I am not leaving the military.",
    "The chatbot says: Let us review your DD214 before continuing.",
    "Can you explain DD Form 214-1?", "What about transition benefits?",
    "I need TRICARE for my family.", "I am just asking about retirement pay.",
  ]) assert.equal(isUserLeavingService(message), false, message);
  assert.equal(isUserLeavingService("I am not separating but I am retiring."), true);
});

test("pathway accepts choices but releases unrelated questions at every stage", () => {
  assert.equal(pathwayTurn("B", "q1", "completed").offPathway, false);
  assert.equal(pathwayTurn("A) Within the next 6 months", "q2", "completed").offPathway, false);
  assert.equal(pathwayTurn("I am not separating.", "q1", "completed").offPathway, true);
  assert.equal(pathwayTurn("What about my TRICARE coverage?", "q2", "completed").offPathway, true);
  assert.equal(pathwayTurn("No, can I ask about my pay?", "not_started", "awareness_asked").offPathway, true);
  assert.equal(pathwayTurn("B", "not_started", "awareness_asked").offPathway, false);
  assert.equal(pathwayTurn("A or B", "q1", "completed").offPathway, false);
});

test("chat endpoint leaves the pathway when the user says they are not separating", async () => {
  const { app } = await import("./server.js");
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/chat`;
    const withoutSignup = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "I am not separating.", chatMode: "transition" }),
    });
    assert.equal(withoutSignup.status, 200);
    assert.equal((await withoutSignup.text()).includes('"conversationState"'), true);
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatMode: "transition",
        message: "I am not separating.", dd214PathwayState: "awareness_asked",
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).type, "done");
    assert.match(events.at(-1).finalText, /stop the DD Form 214-1 and transition questions/i);
    assert.doesNotMatch(events.at(-1).finalText, /Which of these best describes/i);
    assert.deepEqual(events.at(-1).sources, []);
    assert.equal(events.at(-1).transitionIntake.stage, "not_started");
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("pay questions require the 30-day order-length gate", () => {
  assert.match(
    config.systemPrompt,
    /For EVERY question about BAH .* or military pay in\s+general/i
  );
  assert.match(
    config.systemPrompt,
    /Are your orders for\s+30 days or fewer, or are they for more than 30 days\?/i
  );
});

test("pay policy prioritizes DoD FMR Volume 7A over the ROA matrix", () => {
  assert.match(config.systemPrompt, /use retrieved\s+DoD Financial Management Regulation/i);
  assert.match(config.systemPrompt, /Do NOT use the ROA RC Duty Status Benefits Matrix/i);
});

test("short-order BAH distinguishes contingency orders from BAH-RC", () => {
  assert.match(config.systemPrompt, /Are these orders in support\s+of a contingency operation\?/i);
  assert.match(config.systemPrompt, /full BAH beginning on day one/i);
  assert.match(config.systemPrompt, /primary\/permanent residence/i);
  assert.match(config.systemPrompt, /BAH-RC .* a flat national\s+rate based on pay grade and dependency status/i);
  assert.match(config.systemPrompt, /Do not ask for or use a\s+ZIP code to calculate BAH-RC/i);
  assert.match(config.systemPrompt, /14-day Annual Training order does NOT receive full\s+ZIP-code BAH/i);
  assert.match(config.systemPrompt, /ordinary 14-day Annual Training .* not in support of a\s+contingency operation/i);
});

test("Annual Training choice confirms duty type then asks grade, without mobilization or BAH questions", async () => {
  const { app } = await import("./server.js");
  const originalRetrievalClient = app.locals.retrievalClient;
  const originalStream = Anthropic.Messages.prototype.stream;
  let externalCalls = 0;
  app.locals.retrievalClient = {
    indexHost: "fixture.invalid",
    embed: async () => { externalCalls++; throw new Error("Training intake must not retrieve"); },
  };
  Anthropic.Messages.prototype.stream = () => {
    externalCalls++;
    throw new Error("Training intake must not call the model");
  };
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/chat`;
    const q1 = config.systemPrompt.match(/PAY INTAKE QUESTION 1[\s\S]*?PAY INTAKE QUESTION 2/)?.[0];
    assert.ok(q1);
    const states = new Map();
    async function send(id, message, conversationHistory) {
      const response = await fetch(url, {
        // Isolate this multi-turn fixture from other tests' shared rate window.
        method: "POST", headers: {
          "content-type": "application/json", "x-forwarded-for": "192.0.2.61",
        },
        body: JSON.stringify({ conversationState: states.get(id), chatMode: "pay", message, conversationHistory }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).split("\n")
        .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type, "done");
      assert.equal(events.filter(event => event.type === "done").length, 1);
      assert.equal(events.some(event => event.type === "error"), false);
      assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""),
        events.at(-1).finalText);
      assert.deepEqual(events.at(-1).sources, []);
      states.set(id, events.at(-1).conversationState);
      return events.at(-1).finalText;
    }
    const history = [
      { role: "user", content: "I need help with my pay" },
      { role: "assistant", content: q1 },
    ];
    const confirm = await send("training-pay-intake-one", "B", history);
    assert.match(confirm, /is this Annual Training \(AT\) or Active Duty for Training \(ADT\)/);
    assert.doesNotMatch(confirm, /30 days|mobilization authority|contingency operation/i);
    history.push({ role: "user", content: "B" }, { role: "assistant", content: confirm });
    const unclear = await send("training-pay-intake-one", "not sure which", history);
    assert.match(unclear, /choose AT or ADT/i);
    const grade = await send("training-pay-intake-one", "A) Annual Training (AT)", history);
    assert.match(grade, /What is your pay grade\?/);
    assert.doesNotMatch(grade, /30 days|mobilization authority|contingency operation/i);
    const adtConfirmation = await send("training-pay-intake-three", "B", [
      { role: "user", content: "Help with my pay" },
      { role: "assistant", content: q1 },
    ]);
    assert.match(adtConfirmation, /Annual Training \(AT\) or Active Duty for Training \(ADT\)/);
    const adtGrade = await send("training-pay-intake-three", "B) Active Duty for Training (ADT)", []);
    assert.match(adtGrade, /What is your pay grade\?/);
    assert.doesNotMatch(adtGrade, /mobilization authority|30 days/i);

    // Explicit training duty in the original question needs no second confirmation.
    const explicit = await send("training-pay-intake-two", "B", [
      { role: "user", content: "I am on Annual Training (AT) orders. What is my pay?" },
      { role: "assistant", content: q1 },
    ]);
    assert.match(explicit, /What is your pay grade\?/);
    assert.doesNotMatch(explicit, /mobilization authority|30 days/i);

    const skipConfirmation = await send("training-pay-intake-skip", "B", history.slice(0, 2));
    assert.match(skipConfirmation, /Annual Training \(AT\) or Active Duty for Training \(ADT\)/);
    const skipGrade = await send("training-pay-intake-skip", "Skip", []);
    assert.match(skipGrade, /What is your pay grade\?/);
    assert.deepEqual(states.get("training-pay-intake-skip").payTraining, { stage: "grade", type: null });
    assert.equal(externalCalls, 0);
  } finally {
    app.locals.retrievalClient = originalRetrievalClient;
    Anthropic.Messages.prototype.stream = originalStream;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("numeric service years advance the pay intake on the first reply", async () => {
  const { app } = await import("./server.js");
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/chat`;
    const yearsQuestion = config.systemPrompt.match(/PAY INTAKE QUESTION 5[\s\S]*?PAY INTAKE QUESTION 6/)?.[0];
    assert.ok(yearsQuestion);
    const history = [
      { role: "user", content: "CONUS" },
      { role: "assistant", content: yearsQuestion },
    ];
    const states = new Map();
    async function send(id, message, conversationHistory = history) {
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationState: states.get(id), chatMode: "pay", message, conversationHistory }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).split("\n")
        .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type, "done");
      assert.equal(events.filter(event => event.type === "done").length, 1);
      states.set(id, events.at(-1).conversationState);
      return events.at(-1).finalText;
    }
    for (const [id, answer] of [
      ["pay-years-bare-seven", "7"],
      ["pay-years-labeled-seven", "7 years"],
    ]) {
      const response = await send(id, answer);
      assert.equal(response, PAY_DEPENDENTS_QUESTION);
      assert.doesNotMatch(response, /how many years|confirm.*years|orders for 30 days|pay grade/i);
    }
    const id = "pay-years-invalid-value";
    assert.match(await send(id, "700"), /whole number from 0 to 60/);
    assert.match(await send(id, "7 days"), /whole number from 0 to 60/);
    assert.equal(await send(id, "7", []), PAY_DEPENDENTS_QUESTION);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("single-letter pay replies resolve the current question and advance without repeating it", async () => {
  const { app } = await import("./server.js");
  const originalStream = Anthropic.Messages.prototype.stream;
  app.locals.retrievalClient = sourceFixtureClient();
  Anthropic.Messages.prototype.stream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Let's discuss your new question." } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    },
  });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const states = new Map();
  const histories = new Map();
  async function send(id, message, conversationHistory = histories.get(id) || []) {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationState: states.get(id), chatMode: "pay", message, conversationHistory }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).type, "done");
    states.set(id, events.at(-1).conversationState);
    histories.set(id, [...conversationHistory, { role: "user", content: message }, { role: "assistant", content: events.at(-1).finalText }]);
    return events.at(-1).finalText;
  }
  const location = "Are you serving CONUS (within the continental United States) or OCONUS (overseas or outside the continental US)?\n\nA) CONUS\nB) OCONUS — if you know it, what country or region?\n(Skip this question)";
  try {
    // Start with the years question exactly as a client that has just been
    // asked Q5 would; the server then owns the next pending question.
    const years = [{ role: "assistant", content: PAY_YEARS_QUESTION }];
    for (const [id, answer] of [["pay-dependent-upper", "B"], ["pay-dependent-lower", "b"], ["pay-dependent-paren", "B)"]]) {
      assert.equal(await send(id, "7", years), PAY_DEPENDENTS_QUESTION);
      assert.equal(await send(id, answer), PAY_OTHER_CIRCUMSTANCES_QUESTION);
      assert.notEqual(await send(id + "-history", answer, [
        { role: "assistant", content: PAY_DEPENDENTS_QUESTION },
        { role: "user", content: "I have a different question" },
      ]), PAY_OTHER_CIRCUMSTANCES_QUESTION);
    }
    assert.equal(await send("pay-location-letter", "a", [
      { role: "user", content: "E-5" }, { role: "assistant", content: location },
    ]), PAY_YEARS_QUESTION);
    // A newer, unrelated assistant question overrides the server's pending Q6.
    assert.equal(await send("pay-new-question", "7", years), PAY_DEPENDENTS_QUESTION);
    assert.notEqual(await send("pay-new-question", "B", [
      { role: "assistant", content: PAY_DEPENDENTS_QUESTION },
      { role: "user", content: "Let's talk about something else" },
      { role: "assistant", content: "What else would you like help with?" },
    ]), PAY_OTHER_CIRCUMSTANCES_QUESTION);
    assert.equal(await send("pay-topic-switch", "7", years), PAY_DEPENDENTS_QUESTION);
    assert.match(await send("pay-topic-switch", "Can you help me with a different topic?"), /new question/);
    assert.notEqual(await send("pay-topic-switch", "B"), PAY_OTHER_CIRCUMSTANCES_QUESTION);
  } finally {
    delete app.locals.retrievalClient;
    Anthropic.Messages.prototype.stream = originalStream;
    await new Promise(resolve => server.close(resolve));
  }
});

test("pay letter parser accepts only offered letters in the latest question", () => {
  const question = letteredPayQuestion(PAY_DEPENDENTS_QUESTION);
  for (const reply of ["B", "b", "B)"]) {
    assert.deepEqual(selectedPayOption(question, reply), { letter: "B", answer: "No dependents" });
  }
  assert.equal(selectedPayOption(question, "C"), null);
  assert.equal(selectedPayOption(question, "B, and what about my orders?"), null);
  assert.equal(letteredPayQuestion(`${PAY_DEPENDENTS_QUESTION}\nWhat about your orders?`), null);
});

test("pay years parser does not assign a number to a different field", () => {
  assert.equal(lastPayQuestion("What is your pay grade?"), null);
  assert.equal(lastPayQuestion("Are your orders for 30 days or fewer?"), null);
  assert.equal(lastPayQuestion("Basic pay depends on years of service."), null);
  assert.equal(lastPayQuestion("How many years have you served in the military (total, all components)?"), "yearsOfService");
  assert.equal(lastPayQuestion(PAY_DEPENDENTS_QUESTION), "dependents");
  assert.deepEqual(parseServiceYears("7"), { kind: "years", value: 7 });
  assert.deepEqual(parseServiceYears("7 years"), { kind: "years", value: 7 });
  for (const answer of ["70", "7 days", "7 or 8", "-7", "7.5", "E-7"]) {
    assert.deepEqual(parseServiceYears(answer), { kind: "invalid" });
  }
});

test("mixed benefits and BAH wording uses the pay route", () => {
  assert.equal(
    classifyQuery("What benefit and BAH do I get on 20-day orders?").key,
    "pay"
  );
});

test("legal wording does not suppress FMR pay-policy retrieval", () => {
  assert.equal(
    classifyQuery("What are my legal rights to BAH on 20-day orders?").key,
    "legal"
  );
  assert.equal(
    isPayPolicyQuery("What are my legal rights to BAH on 20-day orders?"),
    true
  );
  assert.equal(
    isBahQuery("What are my legal rights to BAH on 20-day orders?"),
    true
  );
});

test("all known ROA matrix metadata variants are excluded", () => {
  assert.equal(
    isRoaPayMatrixMatch({
      metadata: {
        title: "RC Duty Status Benefits Matrix v2.0",
        source: "./duty_status_matrix_v2-3.html",
      },
    }),
    true
  );
  assert.equal(
    isRoaPayMatrixMatch({
      metadata: { title: "ROA RC Duty Status Benefits Matrix v2.0" },
    }),
    true
  );
});

test("DD Form 214-1 pathway covers all transition triggers", () => {
  for (const message of [
    "I am transitioning out.",
    "I face an administrative separation.",
    "I am retiring.",
    "I am leaving active duty.",
    "I am leaving active service.",
    "I am leaving service.",
    "I am leaving my Reserve Component.",
    "I am leaving the Army Reserve.",
    "I am leaving the Air Force Reserve.",
    "I am leaving the Reserve.",
    "I am getting out.",
    "I may be discharged.",
    "I am being released from active duty.",
    "The chatbot says: Let us review your DD-214 before continuing.",
    "The chatbot says: Let us review your DD214 before continuing.",
  ]) {
    assert.equal(isDd214PathwayQuery(message), true, message);
  }
});

test("DD Form 214-1 state prevents repetition after completion", () => {
  assert.equal(
    advanceDd214PathwayState("not_started", "I am leaving service.", true),
    "awareness_asked"
  );
  assert.equal(
    advanceDd214PathwayState("awareness_asked", "No, I do not know.", true),
    "review_offered"
  );
  for (const uncertain of [
    "I am not sure.",
    "I'm not sure.",
    "Actually, no.",
    "Absolutely not.",
    "C) I am not sure.",
  ]) {
    assert.equal(
      advanceDd214PathwayState("awareness_asked", uncertain, true),
      "review_offered",
      uncertain
    );
  }
  assert.equal(
    advanceDd214PathwayState("awareness_asked", "A) Yes.", true),
    "completed"
  );
  assert.equal(
    advanceDd214PathwayState("review_offered", "Yes, show me.", true),
    "completed"
  );
  assert.equal(
    advanceDd214PathwayState("completed", "I am retiring now.", false),
    "completed"
  );
});

test("DD Form 214-1 pathway asks staged questions and covers Table 2", () => {
  assert.match(config.systemPrompt, /do you know what a DD Form 214-1 is/i);
  assert.match(config.systemPrompt, /Would you like to review the most important information/i);
  assert.match(config.systemPrompt, /Total Active Points .* Total Inactive Points/i);
  assert.match(config.systemPrompt, /Total Points for Retired Pay/i);
  assert.match(config.systemPrompt, /Total Service for Pay/i);
  assert.match(config.systemPrompt, /Creditable Service for Retired Pay/i);
  assert.match(config.systemPrompt, /NRR Age Reduction Amount/i);
  assert.match(config.systemPrompt, /ALL Activations across the member's entire career/i);
  assert.match(config.systemPrompt, /Annual Training, ADOS, Active Guard\/Reserve service/i);
  assert.match(config.systemPrompt, /should not sign a DD Form 214 or DD Form 214-1 they know\s+is incorrect/i);
  assert.match(
    config.systemPrompt,
    /never present DD Form 214 as the only separation\s+service record/i
  );
  assert.match(
    config.systemPrompt,
    /paired DD Form 214 and DD Form 214-1 checklist/i
  );
  assert.match(
    config.systemPrompt,
    /Drill\/IDT-only service does not substitute a DD Form 256/i
  );
  assert.match(
    config.systemPrompt,
    /no active-duty orders\s+over 180 days/i
  );
});

test("incorrect DD Form 256 substitution is removed from final answers", () => {
  const incorrect = `RESERVE-SPECIFIC NOTE

If you've only performed drill/IDT duty and never been on active duty orders over 180 days, you may receive a DD Form 256 (Honorable Discharge Certificate) instead of a DD-214. If you've had qualifying active duty periods, ensure each period is properly documented.`;
  const corrected = correctDd214IssuanceClaims(incorrect);
  assert.doesNotMatch(corrected, /may receive a DD Form 256/i);
  assert.match(corrected, /must be issued a DD Form 214 and DD Form 214-1 together/i);
  assert.match(corrected, /do not replace this requirement with a DD Form 256/i);
});
