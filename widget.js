(function () {
  // ROA public-site installation remains blocked until ROA approves it.
  if (["roa.org", "www.roa.org"].includes(window.location.hostname.toLowerCase())) return;

  // ------------------------------------------------------------
  // ROA CHATBOT WIDGET
  // Configure branding and behavior below; presentation rules follow.
  // ------------------------------------------------------------

  const CONFIG = {
    backendUrl: new URL(document.currentScript?.src || "https://roa-chatbot-backend.onrender.com", window.location.href).origin,
    botName: "ReserveConnect Navigator",
    welcomeMessage: "Hello. I search the full ReserveConnect knowledge base, with a focus on VA disability claims and benefits. Disability answers require relevant source support. What can I help you research?",
    primaryColor: "#01225E",       // ReserveConnect navy blue
    accentColor: "#B61D30",        // ReserveConnect red
    steelColor: "#849CC1",
    privacyPolicyUrl: "https://www.roa.org/privacy-policy",
    quickQuestions: [
      "I'm transitioning out of the Guard/Reserve. What should I do next?",
      "I have questions about VA disability ratings.",
      "I have questions about presumptive conditions.",
      "How do I start a disability claim?",
      "Help! I don't know where to start to get VA help.",
      "I am in crisis and need help.",
      "How can I tell whether I'm a veteran?",
    ],
    lawCenterQuickQuestions: [
      "Help! I was fired/harassed/not promoted due to Guard/Reserve Service",
      "I'm researching VA disability claims",
      "I'm a pilot-how does USERRA protect me?",
      "Returning to work: What are my protections",
      "I'm in the Guard & Reserve-how does voting work when out of state or overseas?",
      "What is USERRA?",
    ],
    position: "bottom-right",      // or "bottom-left"
  };
  const AI_DISCLOSURE_NOTICE = "You're chatting with an AI assistant from the Reserve Organization of America (ROA), not a human. It can make mistakes, and it isn't a substitute for advice from a lawyer, doctor, counselor, or other professional.\n\nPlease don't enter personal information such as your Social Security number, DoD ID number, date of birth, home address, phone number, or other details that could identify you.";
  const DISCLOSURE_REMINDER_MS = 3 * 60 * 60 * 1000;
  const CRISIS_RESOURCES = {
    opening: "You're not alone, and help is available right now — free, confidential, 24/7.",
    veterans: "VETERANS CRISIS LINE",
    veteransAudience: "For service members (including National Guard and Reserve), veterans, and their families. You don't need to be enrolled in VA.",
    lifeline: "988 SUICIDE & CRISIS LIFELINE",
    closing: "I'm an AI assistant and can't provide crisis counseling, but the people at these lines are trained to help.",
  };

  // --- Inject Styles ---
  const style = document.createElement("style");
  style.textContent = `
    @import url("https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&family=Roboto+Slab:wght@500;600&display=swap");

    #roa-chat-bubble {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: ${CONFIG.accentColor};
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      transition: transform 0.2s;
      border: 0;
      color: white;
    }
    #roa-chat-bubble:hover { transform: scale(1.08); }
    #roa-chat-bubble[aria-expanded="true"] { visibility: hidden; }
    #roa-chat-bubble svg { width: 28px; height: 28px; fill: white; }
    #roa-chat-bubble:focus-visible, #roa-chat-window button:focus-visible {
      outline: 3px solid ${CONFIG.accentColor};
      outline-offset: 3px;
    }

    #roa-chat-window {
      box-sizing: border-box;
      position: fixed;
      bottom: 4px;
      right: 24px;
      width: min(600px, calc(100vw - 48px));
      height: min(960px, calc(100dvh - 8px));
      border: 1px solid rgba(1,34,94,.14);
      border-radius: 18px;
      background: #fbfcfe;
      box-shadow: 0 22px 60px rgba(1,34,94,.22), 0 4px 12px rgba(1,34,94,.08);
      display: none;
      flex-direction: column;
      z-index: 99998;
      font-family: "Roboto", sans-serif;
      overflow: hidden;
      color: ${CONFIG.primaryColor};
      font-size: 16px;
    }
    #roa-chat-window *, #roa-chat-window *::before, #roa-chat-window *::after { box-sizing: border-box; }
    #roa-chat-window.open { display: flex; }
    #roa-privacy-details {
      margin: 0;
      padding: 4px 14px;
      background: #eaf0f8;
      color: ${CONFIG.primaryColor};
      border-bottom: 1px solid #cbd7e5;
      font: 14px/1.45 "Roboto", sans-serif;
      flex-shrink: 0;
    }
    #roa-privacy-details summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      cursor: pointer;
      font-weight: 600;
      list-style: none;
    }
    #roa-privacy-details summary::-webkit-details-marker { display: none; }
    .roa-privacy-action { margin-left: auto; white-space: nowrap; text-decoration: underline; }
    #roa-privacy-details:not([open]) .roa-privacy-action-close,
    #roa-privacy-details[open] .roa-privacy-action-open { display: none; }
    #roa-privacy-details p {
      margin: 5px 0 3px;
      max-height: 72px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    #roa-privacy-details p:focus-visible { outline: 3px solid ${CONFIG.primaryColor}; outline-offset: -3px; }
    #roa-privacy-details a { color: ${CONFIG.accentColor}; text-decoration: underline; }
    #roa-ai-notice {
      margin: 0;
      padding: 12px 14px;
      max-height: 100px;
      overflow-y: auto;
      overscroll-behavior: contain;
      background: #fff8e8;
      color: #263b59;
      border-bottom: 1px solid #e7d8ae;
      font: 14px/1.5 "Roboto", sans-serif;
      flex-shrink: 0;
    }
    #roa-ai-notice p { margin: 0; }
    #roa-ai-notice p + p { margin-top: 7px; }
    #roa-ai-notice:focus-visible { outline: 3px solid ${CONFIG.primaryColor}; outline-offset: -3px; }
    #roa-crisis-pin { padding: 7px 14px; background: #fff6f3; border-bottom: 1px solid #edc4bb; }
    #roa-crisis-pin[hidden] { display: none; }
    #roa-crisis-pin summary { color: #8f1425; cursor: pointer; font: 700 14px/1.4 "Roboto", sans-serif; }
    #roa-crisis-resources { margin-top: 9px; }
    .roa-crisis-card {
      align-self: stretch;
      max-width: 100%;
      padding: 16px;
      border: 2px solid #9e1b32;
      border-left-width: 6px;
      border-radius: 12px;
      background: #fff8f6;
      color: #182d4a;
      font: 15px/1.55 "Roboto", sans-serif;
      box-shadow: 0 3px 12px rgba(1,34,94,.12);
      overflow-wrap: anywhere;
    }
    .roa-crisis-card h2 { margin: 0 0 9px; color: #8f1425; font: 700 17px/1.3 "Roboto Slab", serif; }
    .roa-crisis-card h3 { margin: 12px 0 4px; color: #01225E; font: 700 14px/1.4 "Roboto", sans-serif; }
    .roa-crisis-card p { margin: 6px 0; }
    .roa-crisis-card ul { margin: 4px 0 8px; padding-left: 20px; }
    .roa-crisis-card a { color: #8f1425; font-weight: 700; text-decoration: underline; }
    .roa-redaction-note {
      align-self: stretch;
      border: 1px solid #e7d8ae;
      border-radius: 9px;
      padding: 9px 11px;
      background: #fff8e8;
      color: #3b4655;
      font: 14px/1.45 "Roboto", sans-serif;
    }

    #roa-chat-header {
      background: white;
      color: ${CONFIG.primaryColor};
      min-height: 56px;
      padding: 0 12px;
      font-family: "Roboto Slab", serif;
      font-weight: 600;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid ${CONFIG.steelColor};
      gap: 8px;
      flex-shrink: 0;
    }
    #roa-header-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: ${CONFIG.primaryColor};
      min-width: 0;
      overflow-wrap: anywhere;
    }
    #roa-header-logo {
      width: 36px;
      height: 36px;
      display: block;
      border-radius: 9px;
      object-fit: contain;
    }
    #roa-close-btn {
      background: none;
      border: none;
      color: ${CONFIG.primaryColor};
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }
    #roa-close-btn:hover { color: ${CONFIG.steelColor}; opacity: 1; }

    #roa-messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f3f6fa;
    }

    .roa-msg {
      max-width: 88%;
      padding: 11px 13px;
      border-radius: 13px;
      font-size: 16px;
      line-height: 1.52;
      overflow-wrap: anywhere;
    }
    .roa-msg.bot {
      max-width: 100%;
      background: white;
      color: ${CONFIG.primaryColor};
      align-self: flex-start;
      border: 1px solid #e3eaf2;
      border-bottom-left-radius: 4px;
      box-shadow: 0 2px 6px rgba(1,34,94,.06);
    }
    .roa-msg.bot p { margin: 0 0 8px; }
    .roa-msg.bot p:last-child { margin-bottom: 0; }
    .roa-msg.bot ul, .roa-msg.bot ol { margin: 0 0 8px; padding-left: 18px; }
    .roa-msg.bot ul:last-child, .roa-msg.bot ol:last-child { margin-bottom: 0; }
    .roa-msg.bot li { margin-bottom: 4px; }
    .roa-msg.bot .md-heading { font-weight: 700; margin: 9px 0 4px; }
    .roa-msg.bot strong { color: ${CONFIG.primaryColor}; font-weight: 700; }
    .roa-msg.bot:focus { outline: 3px solid ${CONFIG.accentColor}; outline-offset: 2px; }
    .roa-msg.user {
      background: ${CONFIG.primaryColor};
      color: white;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .roa-msg.typing {
      background: white;
      align-self: flex-start;
      color: #52657e;
      font-style: italic;
      font-size: 16px;
    }
    .roa-quick-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      width: 88%;
    }
    .roa-quick-btn {
      border: 1px solid rgba(182,29,48,.45);
      border-radius: 20px;
      padding: 11px 12px;
      color: ${CONFIG.accentColor};
      cursor: pointer;
      background: transparent;
      font: 500 14px/1.4 "Roboto", sans-serif;
      text-align: left;
    }
    .roa-quick-btn:hover { background: ${CONFIG.accentColor}; color: white; }
    .roa-quick-btn:disabled { cursor: wait; opacity: .55; }

    .roa-sources {
      font-size: 14px;
      line-height: 1.45;
      color: ${CONFIG.primaryColor};
      margin-top: 6px;
      align-self: flex-start;
      max-width: 100%;
      min-width: 0;
    }
    .roa-sources::first-line { color: ${CONFIG.primaryColor}; font-weight: 700; }
    .roa-sources a {
      color: ${CONFIG.accentColor};
      text-decoration: underline;
      display: block;
      overflow-wrap: anywhere;
      padding: 6px 2px;
    }
    .roa-sources a:hover { text-decoration: underline; }

    #roa-input-area {
      display: flex;
      padding: 6px 10px;
      border-top: 1px solid #eee;
      gap: 8px;
      background: white;
      align-items: flex-end;
      flex-shrink: 0;
    }
    .roa-input-group {
      flex: 1;
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      column-gap: 6px;
    }
    .roa-input-group label {
      grid-column: 2;
      grid-row: 1;
      color: ${CONFIG.primaryColor};
      font: 500 14px "Roboto", sans-serif;
      margin: 0 3px 4px 0;
    }
    .roa-ai-label {
      grid-column: 1;
      grid-row: 1;
      margin: 0 0 4px 3px;
      color: #46576d;
      font: 600 12px/1.3 "Roboto", sans-serif;
    }
    #roa-input {
      grid-column: 1 / -1;
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #cad5e2;
      border-radius: 20px;
      padding: 9px 14px;
      font-size: 16px;
      outline: none;
      resize: none;
      font-family: inherit;
    }
    #roa-input:focus-visible { outline: 3px solid ${CONFIG.primaryColor}; outline-offset: 2px; }
    #roa-send-btn {
      background: ${CONFIG.accentColor};
      border: none;
      border-radius: 50%;
      width: 44px;
      height: 44px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    #roa-send-btn:hover { background: ${CONFIG.accentColor}; }
    #roa-send-btn svg { width: 18px; height: 18px; fill: white; }
    #roa-answer-actions { padding: 0 12px; background: white; flex-shrink: 0; }
    #roa-read-answer {
      border: 1px solid ${CONFIG.primaryColor};
      border-radius: 7px;
      background: white;
      color: ${CONFIG.primaryColor};
      min-height: 44px;
      padding: 8px 12px;
      cursor: pointer;
      font: 500 14px "Roboto", sans-serif;
    }
    #roa-read-answer[hidden] { display: none; }
    #roa-status {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    #roa-chat-window #roa-disclaimer {
      font-size: 14px;
      line-height: 1.45;
      color: #46576d;
      text-align: center;
      padding: 4px 10px;
      border-top: 1px solid #e5eaf0;
      background: white;
      flex-shrink: 0;
    }

    #roa-clear-btn { border: 1px solid #cbd7e5; background: white; color: ${CONFIG.primaryColor};
      border-radius: 7px; min-height: 44px; padding: 8px; cursor: pointer; font: 500 14px Roboto,sans-serif; margin-left: auto; }
    #roa-signup-card { align-self: stretch; background: #f3f6fa; border: 1px solid #cbd7e5;
      border-left: 3px solid ${CONFIG.accentColor}; border-radius: 12px; padding: 15px; margin: 10px 0; color: ${CONFIG.primaryColor}; }
    #roa-signup-card h3 { font: 600 17px "Roboto Slab", serif; margin: 0 0 5px; }
    #roa-signup-card p { font: 14px/1.45 Roboto,sans-serif; }
    #roa-signup-card p { margin: 0 0 10px; }
    #roa-signup-card .roa-invite-option { margin: 0 0 12px; }
    #roa-signup-card a { color: ${CONFIG.primaryColor}; font-weight: 700; text-decoration: underline; }
    #roa-signup-card button { border: 1px solid ${CONFIG.primaryColor}; border-radius: 7px;
       background: white; color: ${CONFIG.primaryColor}; min-height: 44px; padding: 8px 12px; cursor: pointer; font: 600 14px Roboto,sans-serif; }

    #roa-typing {
      display: flex;
      align-items: center;
      gap: 5px;
      width: fit-content;
      padding: 14px 16px;
      border: 1px solid #e3eaf2;
      border-radius: 13px;
      border-bottom-left-radius: 4px;
      background: white;
      box-shadow: 0 2px 6px rgba(1,34,94,.06);
    }
    #roa-typing span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${CONFIG.steelColor};
      animation: roa-bounce 1.2s infinite;
    }
    #roa-typing span:nth-child(2) { animation-delay: .2s; }
    #roa-typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes roa-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-5px); }
    }

    #roa-chat-window a:focus-visible, #roa-chat-window summary:focus-visible {
      outline: 3px solid ${CONFIG.primaryColor}; outline-offset: 2px;
    }
    #roa-chat-window .roa-law-caption { font-size: 14px; margin-top: 5px; }
    @media (max-width: 620px), (max-height: 600px) {
      #roa-chat-window {
        width: 100%;
        height: var(--roa-visible-height, 100dvh);
        top: var(--roa-visible-top, 0px);
        right: 0;
        bottom: auto;
        border: 0;
        border-radius: 0;
        box-shadow: none;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      #roa-messages { flex: 1 0 120px; }
    }
    @media (max-width: 620px) {
      #roa-chat-header { min-height: 52px; padding: 0 10px; }
      #roa-header-logo { display: none; }
    }
  `;
  document.head.appendChild(style);

  // --- Build HTML Structure ---
  document.body.insertAdjacentHTML("beforeend", `
    <button id="roa-chat-bubble" type="button" aria-label="Open ReserveConnect Navigator chat" aria-expanded="false" aria-controls="roa-chat-window">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>
    </button>
    <div id="roa-chat-window" role="region" aria-label="ReserveConnect Navigator chat">
      <div id="roa-chat-header">
        <div id="roa-header-brand">
          <span>${CONFIG.botName}</span>
          <img id="roa-header-logo" src="${CONFIG.backendUrl}/reserveconnect-ai-explorer-logo.png" alt="">
        </div>
        <button id="roa-clear-btn" type="button" aria-label="Clear conversation">Clear conversation</button>
        <button id="roa-close-btn" aria-label="Close chat">×</button>
      </div>
      <details id="roa-crisis-pin" hidden>
        <summary>Crisis resources</summary>
        <div id="roa-crisis-resources"></div>
      </details>
       <details id="roa-privacy-details"><summary><span>Privacy: Don't enter personal or sensitive info</span><span class="roa-privacy-action"><span class="roa-privacy-action-open">Read more</span><span class="roa-privacy-action-close">Close</span></span></summary><p tabindex="0">Development chat only. Closing chat clears this conversation from this page. ROA's chat application does not save chat transcripts in a database or file; hosting logs still need to be verified. Questions are processed by AI service providers to generate answers: Voyage AI receives search questions, Pinecone receives question-derived vectors, and Anthropic receives questions and chat history. This chat does not use live web search. Do not enter personal or sensitive information, including names, emails, SSNs, account numbers, or medical records. Linked sign-ups happen outside this chat. <a href="${CONFIG.privacyPolicyUrl}" target="_blank" rel="noopener noreferrer">Privacy policy</a></p></details>
      <div id="roa-messages"></div>
      <div id="roa-answer-actions">
        <button id="roa-read-answer" type="button" hidden>Read latest answer</button>
        <div id="roa-status" role="status" aria-live="polite" aria-atomic="true"></div>
      </div>
      <div id="roa-input-area">
        <div class="roa-input-group">
          <span class="roa-ai-label">AI assistant — not a human.</span>
          <label for="roa-input">Message</label>
          <textarea id="roa-input" rows="1" placeholder="Ask about benefits, programs..."></textarea>
        </div>
        <button id="roa-send-btn" type="button" aria-label="Send message">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
        </button>
      </div>
      <div id="roa-disclaimer">AI can be wrong. Verify with ROA.</div>
    </div>
  `);

  // --- State ---
  let conversationHistory = [];
  let dd214PathwayState = "not_started";
  let conversationState = {};
  let crisisSessionActive = false;
  let crisisHarmOthersSession = false;
  let disclosureReminderShown = false;
  let disclosureReminderPending = false;
  let disclosureReminderScheduled = false;
  let requestId = 0;
  let activeRequest = null;
  let isLoading = false;
  const signupKey = "roa-chatbot-invitation-v2";
  let signupProgress = { answers: 0, shown: false };
  try { signupProgress = { ...signupProgress, ...JSON.parse(sessionStorage.getItem(signupKey) || "{}") }; } catch (_) {}
  function saveSignupProgress() {
    try { sessionStorage.setItem(signupKey, JSON.stringify(signupProgress)); } catch (_) {}
  }

  // --- DOM refs ---
  const bubble      = document.getElementById("roa-chat-bubble");
  const chatWindow  = document.getElementById("roa-chat-window");
  const messages    = document.getElementById("roa-messages");
  const input       = document.getElementById("roa-input");
  const sendBtn     = document.getElementById("roa-send-btn");
  const closeBtn    = document.getElementById("roa-close-btn");
  const readAnswerBtn = document.getElementById("roa-read-answer");
  const status      = document.getElementById("roa-status");
  const crisisPin   = document.getElementById("roa-crisis-pin");
  const crisisResources = document.getElementById("roa-crisis-resources");
  let latestAnswer = null;

  function createCrisisCard(harmOthers = false, id = "") {
    const card = document.createElement("section");
    card.className = "roa-crisis-card";
    card.setAttribute("role", id ? "alert" : "note");
    card.setAttribute("aria-label", "Crisis support resources");
    if (id) card.id = id;
    if (harmOthers) {
      const danger = document.createElement("p");
      danger.textContent = "If anyone is in immediate danger, call 911.";
      danger.className = "roa-crisis-danger";
      card.appendChild(danger);
    }
    const heading = document.createElement("h2");
    heading.textContent = "Crisis support";
    card.appendChild(heading);
    const opening = document.createElement("p");
    opening.textContent = CRISIS_RESOURCES.opening;
    card.appendChild(opening);

    const veteransHeading = document.createElement("h3");
    veteransHeading.textContent = CRISIS_RESOURCES.veterans;
    card.appendChild(veteransHeading);
    const audience = document.createElement("p");
    audience.textContent = CRISIS_RESOURCES.veteransAudience;
    card.appendChild(audience);
    const veteransList = document.createElement("ul");
    const addLinkItem = (label, href) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      if (href.startsWith("https:")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      item.appendChild(link);
      veteransList.appendChild(item);
    };
    addLinkItem("Call 988, then press 1", "tel:988");
    addLinkItem("Text 838255", "sms:838255");
    addLinkItem("Chat online: veteranscrisisline.net", "https://www.veteranscrisisline.net");
    card.appendChild(veteransList);

    const lifelineHeading = document.createElement("h3");
    lifelineHeading.textContent = CRISIS_RESOURCES.lifeline;
    card.appendChild(lifelineHeading);
    const lifelineList = document.createElement("ul");
    const callItem = document.createElement("li");
    const callLink = document.createElement("a");
    callLink.href = "tel:988";
    callLink.textContent = "Call 988";
    callItem.appendChild(callLink);
    lifelineList.appendChild(callItem);
    const textItem = document.createElement("li");
    const textLink = document.createElement("a");
    textLink.href = "sms:988";
    textLink.textContent = "Text 988";
    textItem.appendChild(textLink);
    lifelineList.appendChild(textItem);
    const chatItem = document.createElement("li");
    const chatLink = document.createElement("a");
    chatLink.href = "https://988lifeline.org";
    chatLink.target = "_blank";
    chatLink.rel = "noopener noreferrer";
    chatLink.textContent = "Chat online: 988lifeline.org";
    chatItem.appendChild(chatLink);
    lifelineList.appendChild(chatItem);
    card.appendChild(lifelineList);

    if (!harmOthers) {
      const danger = document.createElement("p");
      danger.textContent = "If you or someone else is in immediate danger, call 911.";
      card.appendChild(danger);
    }
    const closing = document.createElement("p");
    closing.textContent = CRISIS_RESOURCES.closing;
    card.appendChild(closing);
    return card;
  }

  function activateCrisisResources(harmOthers = false) {
    crisisSessionActive = true;
    crisisHarmOthersSession ||= harmOthers;
    crisisPin.hidden = false;
    crisisResources.replaceChildren(createCrisisCard(crisisHarmOthersSession));
    document.getElementById("roa-quick-actions")?.remove();
    document.getElementById("roa-signup-card")?.remove();
    conversationState = { ...conversationState, crisisActive: true };
  }

  function showDisclosureNotice({ reminder = false } = {}) {
    const notice = document.createElement("aside");
    notice.id = reminder ? "roa-ai-reminder" : "roa-ai-notice";
    notice.setAttribute("role", "note");
    if (!reminder) {
      notice.tabIndex = 0;
      notice.setAttribute("aria-label", "AI and privacy warning; scroll for more");
    }
    if (reminder) notice.setAttribute("aria-live", "polite");
    const sentences = AI_DISCLOSURE_NOTICE.split("\n\n");
    for (const sentence of sentences) {
      const paragraph = document.createElement("p");
      paragraph.textContent = sentence;
      notice.appendChild(paragraph);
    }
    if (reminder) {
      notice.style.cssText = "align-self:stretch;padding:11px 13px;background:#fff8e8;color:#263b59;border:1px solid #e7d8ae;border-radius:9px;font:14px/1.5 Roboto,sans-serif;";
      messages.appendChild(notice);
      messages.scrollTop = messages.scrollHeight;
      disclosureReminderShown = true;
      disclosureReminderPending = false;
      return notice;
    }
    messages.appendChild(notice);
    return notice;
  }

  function showPendingDisclosureReminder() {
    if (disclosureReminderPending && !disclosureReminderShown) {
      showDisclosureNotice({ reminder: true });
    }
  }

  function scheduleDisclosureReminder() {
    if (disclosureReminderScheduled) return;
    disclosureReminderScheduled = true;
    window.setTimeout(() => {
      if (disclosureReminderShown) return;
      if (chatWindow.classList.contains("open")) {
        showDisclosureNotice({ reminder: true });
      } else {
        disclosureReminderPending = true;
      }
    }, DISCLOSURE_REMINDER_MS);
  }

  // The visual viewport shrinks when a mobile keyboard opens (unlike 100vh on
  // some browsers). Keep the full-screen panel inside the visible area.
  function syncVisibleViewport() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    chatWindow.style.setProperty("--roa-visible-height", `${viewport.height}px`);
    chatWindow.style.setProperty("--roa-visible-top", `${viewport.offsetTop}px`);
  }
  window.visualViewport?.addEventListener("resize", syncVisibleViewport);
  window.visualViewport?.addEventListener("scroll", syncVisibleViewport);
  syncVisibleViewport();

  function announceStatus(message) {
    status.textContent = message;
  }

  function publishAnswer(message, announcement = "Answer ready. Use Read latest answer to review it.") {
    latestAnswer?.removeAttribute("aria-label");
    latestAnswer = message;
    latestAnswer.tabIndex = -1;
    latestAnswer.setAttribute("role", "article");
    latestAnswer.setAttribute("aria-label", "Latest chatbot answer");
    readAnswerBtn.hidden = false;
    announceStatus(announcement);
  }

  function offerSignup() {
    if (crisisSessionActive || signupProgress.shown || signupProgress.answers < 4 ||
        document.getElementById("roa-signup-card")) return;
    signupProgress.shown = true;
    saveSignupProgress();
    const card = document.createElement("section");
    card.id = "roa-signup-card";
    card.setAttribute("aria-label", "Optional ROA updates and membership");
    card.innerHTML = `<h3>Stay connected with ROA?</h3>
      <p>These are optional. You can choose any, all, or none and keep chatting.</p>
      <p class="roa-invite-option">Want Reserve-specific news via ROA's SmartBrief?
        <a href="https://newsletter.smartbrief.com/rest/sign-up/36B2225B-FD16-44ED-87FF-31158956003F" target="_blank" rel="noopener noreferrer">Sign up for SmartBrief</a>.</p>
      <p class="roa-invite-option">Want to join ROA's email list?
        <a href="https://roa.org/roaemail/" target="_blank" rel="noopener noreferrer">Join the email list</a>.</p>
      <p class="roa-invite-option">Want to join ROA? If you're currently serving and under 35, membership is free; if you're over 35, it's $20/year.
        <a href="https://roa.org" target="_blank" rel="noopener noreferrer">Join</a>.</p>
      <button type="button" class="roa-later">No thanks — keep chatting</button>`;
    messages.appendChild(card);
    card.querySelector(".roa-later").addEventListener("click", () => {
      card.remove();
      input.focus();
    });
    messages.scrollTop = messages.scrollHeight;
  }


  // --- Functions ---

  function renderMarkdown(raw) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const inline = s => {
      const links = [];
      const link = (label, href) => {
        const token = `__ROA_LINK_${links.length}__`;
        links.push(`<a href="${href}" target="_blank" rel="noopener" style="color:${CONFIG.accentColor};">${label}</a>`);
        return token;
      };
      return esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\((https:\/\/[^)\s<>"']+|\/[^)\s<>"']*)\)/g,
          (_, label, href) => link(label, href.startsWith("/") ? CONFIG.backendUrl + href : href))
        .replace(/(https?:\/\/[^\s<)"]+)/g, `<a href="$1" target="_blank" rel="noopener" style="color:${CONFIG.accentColor};">$1</a>`)
        .replace(/__ROA_LINK_(\d+)__/g, (token, index) => links[Number(index)] || token);
    };
    raw = raw.replace(/\[LAW_CENTER_BANNER\]/g, '\n[LAW_CENTER_BANNER]\n');
    const lines = raw.split('\n');
    const out = [];
    let listType = null, listItems = [];
    function flushList() {
      if (listItems.length) {
        out.push(`<${listType}>${listItems.join('')}</${listType}>`);
        listItems = []; listType = null;
      }
    }
    for (const line of lines) {
      const t = line.trim();
      if (t === '[LAW_CENTER_BANNER]') {
        flushList();
        out.push(`<a href="https://roa.org/lawcenter/" target="_blank" rel="noopener" style="display:block;margin-top:8px;"><img src="${CONFIG.backendUrl}/lawcenter.webp" alt="ROA Reserve Service Law Center" style="width:160px;max-width:100%;height:auto;border-radius:6px;display:block;"></a><p class="roa-law-caption">For more information, visit the <a href="https://roa.org/lawcenter/" target="_blank" rel="noopener" style="color:${CONFIG.accentColor};">ROA Reserve Service Law Center</a>.</p>`);
      } else if (/^[-*•] /.test(t)) {
        if (listType !== 'ul') { flushList(); listType = 'ul'; }
        listItems.push(`<li>${inline(t.replace(/^[-*•] /, ''))}</li>`);
      } else if (/^\d+\. /.test(t)) {
        if (listType !== 'ol') { flushList(); listType = 'ol'; }
        listItems.push(`<li>${inline(t.replace(/^\d+\. /, ''))}</li>`);
      } else {
        if (t === '') {
          // Keep a list open across blank lines so ordered lists do not restart at 1.
        } else if (/^#{1,3} /.test(t)) {
          flushList();
          out.push(`<p class="md-heading">${inline(t.replace(/^#{1,3} /, ''))}</p>`);
        } else {
          flushList();
          out.push(`<p>${inline(t)}</p>`);
        }
      }
    }
    flushList();
    return out.join('');
  }

  function sourceLinks(sources) {
    const sourceList = document.createElement("div");
    sourceList.className = "roa-sources";
    const heading = document.createElement("strong");
    heading.textContent = "Sources";
    sourceList.appendChild(heading);
    for (const source of sources) {
      try {
        const url = new URL(source);
        if (url.protocol !== "https:" || url.username || url.password) continue;
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = url.href.replace(/^https:\/\//, "");
        sourceList.appendChild(link);
      } catch {
        // A malformed or non-HTTPS source is not a safe link.
      }
    }
    return sourceList;
  }

  function addMessage(text, role, sources = []) {
    const msg = document.createElement("div");
    msg.className = `roa-msg ${role}`;
    if (role === "bot") {
      msg.innerHTML = renderMarkdown(text);
    } else {
      msg.textContent = text;
    }
    messages.appendChild(msg);

    // Show sources under bot messages
    if (role === "bot" && sources.length > 0) {
      messages.appendChild(sourceLinks(sources));
    }

    messages.scrollTop = messages.scrollHeight;
    return msg;
  }

  function scrollToAnswerStart(answer) {
    requestAnimationFrame(() => {
      if (!answer?.isConnected) return;
      messages.scrollTop += answer.getBoundingClientRect().top -
        messages.getBoundingClientRect().top - 8;
    });
  }

  function addQuickQuestions() {
    document.getElementById("roa-quick-actions")?.remove();
    if (crisisSessionActive) return;
    const actions = document.createElement("div");
    actions.id = "roa-quick-actions";
    actions.className = "roa-quick-actions";
    const questions = CONFIG.quickQuestions;
    questions.forEach(question => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "roa-quick-btn";
      button.textContent = question;
      button.addEventListener("click", () => {
        input.value = question;
        sendMessage();
      });
      actions.appendChild(button);
    });
    messages.appendChild(actions);
    messages.scrollTop = messages.scrollHeight;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className = "roa-msg typing";
    el.id = "roa-typing";
     el.setAttribute("aria-label", "Searching the knowledge base");
     el.innerHTML = "<span></span><span></span><span></span>";
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() {
    const el = document.getElementById("roa-typing");
    if (el) el.remove();
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || isLoading) return;

    const currentRequest = ++requestId;
    const controller = new AbortController();
    activeRequest = controller;
    isLoading = true;
    latestAnswer?.removeAttribute("aria-label");
    latestAnswer = null;
    readAnswerBtn.hidden = true;
    announceStatus("Searching the knowledge base.");
    input.value = "";
    input.style.height = "auto";

    const userMessage = addMessage(text, "user");
    showTyping();

    // Add to conversation history for multi-turn memory. A later redaction
    // event replaces this copy before any subsequent turn can reuse it.
    const userHistoryIndex = conversationHistory.length;
    conversationHistory.push({ role: "user", content: text });
    let crisisEventReceived = false;

    try {
      const response = await fetch(`${CONFIG.backendUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          conversationHistory: conversationHistory.slice(-20),
          dd214PathwayState,
          conversationState: { ...conversationState, ...(crisisSessionActive ? { crisisActive: true } : {}) },
        }),
      });
      if (currentRequest !== requestId) return;

      if (!response.ok) {
        removeTyping();
        if (response.status === 422) {
          userMessage.remove();
          conversationHistory.pop();
        }
        publishAnswer(addMessage(response.status === 422
          ? "For your privacy, remove email addresses, phone numbers, SSNs, account numbers, and payment card numbers before sending. Please try again without personal details."
          : "Sorry, something went wrong. Please try again.", "bot"),
          "The answer could not be loaded. Use Read latest answer for details.");
      } else {
        // Stream the response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let botMsg = null;
        let srcDiv = null;

        while (true) {
          const { done, value } = await reader.read();
          if (currentRequest !== requestId) {
            await reader.cancel();
            return;
          }
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }

            if (evt.type === "text") {
              if (!botMsg) {
                removeTyping();
                botMsg = addMessage("", "bot");
              }
              fullText += evt.text;
              botMsg.innerHTML = renderMarkdown(fullText);
              messages.scrollTop = messages.scrollHeight;

            } else if (evt.type === "redaction") {
              if (typeof evt.text === "string") {
                userMessage.textContent = evt.text;
                if (conversationHistory[userHistoryIndex]) {
                  conversationHistory[userHistoryIndex].content = evt.text;
                }
              }
              if (typeof evt.notice === "string" && evt.notice) {
                const note = document.createElement("aside");
                note.className = "roa-redaction-note";
                note.setAttribute("role", "status");
                note.textContent = evt.notice;
                messages.appendChild(note);
                messages.scrollTop = messages.scrollHeight;
              }

            } else if (evt.type === "crisis") {
              crisisEventReceived = true;
              activateCrisisResources(evt.harmOthers === true);
              if (conversationHistory[userHistoryIndex]) {
                conversationHistory.splice(userHistoryIndex, 1);
              }
              removeTyping();
              const card = createCrisisCard(evt.harmOthers === true, "roa-crisis-card");
              card.tabIndex = -1;
              messages.appendChild(card);
              card.focus();
              messages.scrollTop = messages.scrollHeight;
              announceStatus("Crisis resources are available in the displayed card and at the top of chat.");

            } else if (evt.type === "done") {
              if (evt.conversationState) {
                conversationState = evt.conversationState;
                if (conversationState.crisisActive) activateCrisisResources();
              }
              if (evt.crisis === true || crisisEventReceived) {
                crisisSessionActive = true;
                if (!crisisEventReceived) {
                  activateCrisisResources(evt.harmOthers === true);
                  removeTyping();
                  const card = createCrisisCard(evt.harmOthers === true, "roa-crisis-card");
                  card.tabIndex = -1;
                  messages.appendChild(card);
                  announceStatus("Crisis resources are available in the displayed card and at the top of chat.");
                }
                if (conversationHistory[userHistoryIndex]) {
                  conversationHistory.splice(userHistoryIndex, 1);
                }
              } else {
                if (!botMsg && evt.finalText) {
                  removeTyping();
                  botMsg = addMessage(evt.finalText, "bot");
                  fullText = evt.finalText;
                }
                if (botMsg && evt.finalText) {
                  fullText = evt.finalText;
                  botMsg.innerHTML = renderMarkdown(fullText);
                }
                conversationHistory.push({ role: "assistant", content: fullText });
                if (evt.dd214PathwayState) {
                  dd214PathwayState = evt.dd214PathwayState;
                }
                if (evt.sources && evt.sources.length && botMsg) {
                  srcDiv = sourceLinks(evt.sources);
                  messages.insertBefore(srcDiv, botMsg.nextSibling);
                  messages.scrollTop = messages.scrollHeight;
                }
                if (!crisisSessionActive) {
                  signupProgress.answers += 1;
                  saveSignupProgress();
                  offerSignup();
                }
                scrollToAnswerStart(botMsg);
                if (botMsg) publishAnswer(botMsg);
              }

            } else if (evt.type === "error") {
              removeTyping();
              botMsg = addMessage(evt.message || "Sorry, something went wrong.", "bot");
              publishAnswer(botMsg, "The answer could not be loaded. Use Read latest answer for details.");
            }
          }
        }

        if (!botMsg && !crisisEventReceived) {
          removeTyping();
          publishAnswer(addMessage("Sorry, I couldn't find an answer. Please try rephrasing or visit roa.org directly.", "bot"),
            "The answer could not be loaded. Use Read latest answer for details.");
        }
      }

    } catch (err) {
      if (currentRequest !== requestId) return;
      removeTyping();
      publishAnswer(addMessage("Connection error. Please check your internet and try again.", "bot"),
        "Connection error. Use Read latest answer for details.");
      console.error("ROA chatbot request failed");
    }

    if (currentRequest !== requestId) return;
    activeRequest = null;
    isLoading = false;
  }

  // --- Event Listeners ---

  function resetConversation() {
    requestId += 1;
    activeRequest?.abort();
    activeRequest = null;
    isLoading = false;
    conversationHistory = [];
    conversationState = crisisSessionActive ? { crisisActive: true } : {};
    dd214PathwayState = "not_started";
    latestAnswer = null;
    readAnswerBtn.hidden = true;
    messages.replaceChildren();
    input.value = "";
    input.style.height = "auto";
    announceStatus("Conversation cleared.");
  }

  function closeChat() {
    resetConversation();
    chatWindow.classList.remove("open");
    bubble.setAttribute("aria-expanded", "false");
    bubble.setAttribute("aria-label", "Open ReserveConnect Navigator chat");
    bubble.focus();
  }

  bubble.addEventListener("click", () => {
    if (chatWindow.classList.contains("open")) {
      closeChat();
      return;
    }
    chatWindow.classList.add("open");
    scheduleDisclosureReminder();
    bubble.setAttribute("aria-expanded", "true");
    bubble.setAttribute("aria-label", "Close ReserveConnect Navigator chat");
    if (messages.children.length === 0) {
      showDisclosureNotice();
      addMessage(CONFIG.welcomeMessage, "bot");
      addQuickQuestions();
      showPendingDisclosureReminder();
      messages.scrollTop = 0;
    }
    input.focus();
  });

  closeBtn.addEventListener("click", closeChat);
  chatWindow.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeChat();
    }
  });
  readAnswerBtn.addEventListener("click", () => latestAnswer?.focus());
  document.getElementById("roa-clear-btn").addEventListener("click", () => {
    resetConversation();
    showDisclosureNotice();
    addMessage(CONFIG.welcomeMessage, "bot");
    addQuickQuestions();
    showPendingDisclosureReminder();
    input.focus();
  });

  sendBtn.addEventListener("click", sendMessage);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea as user types
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 100) + "px";
  });

})();
