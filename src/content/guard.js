// FocusFlow page guard. It decides nothing. The background worker judges the
// page and tells us whether it is "pending" (being checked) or "allowed".
//  - While pending: media stays paused and the page is covered, so nothing
//    distracting is visible before the verdict.
//  - On request ("ff:collect"): read the page's metadata for the judge.
(() => {
  "use strict";
  if (window.__focusFlowGuard) return;
  window.__focusFlowGuard = true;

  const COVER_DELAY_MS = 300; // instant decisions never show the cover
  const RECONNECT_MS = 10_000;
  const privacy = globalThis.FocusFlowPrivacy;

  let holding = false;
  let lastVersion = -1;
  let cover = null;
  let coverTimer = null;
  let reconnectTimer = null;
  let syncing = false;
  const pausedByUs = new Set();
  let snapshot = { url: location.href, title: "" };

  // --- Holding the page -------------------------------------------------------

  function pauseMedia(media) {
    if (!media.paused) {
      pausedByUs.add(media);
      media.pause();
    }
  }

  function onPlay(event) {
    if (holding && event.target instanceof HTMLMediaElement) pauseMedia(event.target);
  }

  function showCover() {
    if (cover || !holding || !document.documentElement) return;
    cover = document.createElement("focusflow-cover");
    const root = cover.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .cover { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
          background: #111111; color: #f5f5f5; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .box { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; padding: 24px; }
        .ring { width: 38px; height: 38px; border-radius: 50%; border: 3px solid #383838; border-top-color: #ffffff;
          animation: spin .9s linear infinite; }
        .title { font-size: 17px; font-weight: 700; }
        .sub { color: #b3b3b3; max-width: 340px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .ring { animation-duration: 3s; } }
      </style>
      <div class="cover" role="alert" aria-busy="true">
        <div class="box">
          <div class="ring"></div>
          <div class="title">FocusFlow is checking this page</div>
          <div class="sub">Checking study content. Hard mode stays on; unverified pages remain blocked.</div>
        </div>
      </div>`;
    document.documentElement.appendChild(cover);
  }

  function hideCover() {
    clearTimeout(coverTimer);
    if (cover) cover.remove();
    cover = null;
  }

  function hold() {
    if (!holding) {
      holding = true;
      document.addEventListener("play", onPlay, true);
    }
    document.querySelectorAll("video, audio").forEach(pauseMedia);
    clearTimeout(coverTimer);
    coverTimer = setTimeout(showCover, COVER_DELAY_MS);
    if (!reconnectTimer) reconnectTimer = setInterval(syncState, RECONNECT_MS);
  }

  function release() {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
    hideCover();
    if (!holding) return;
    holding = false;
    document.removeEventListener("play", onPlay, true);
    for (const media of pausedByUs) {
      if (media.isConnected) media.play().catch(() => {});
    }
    pausedByUs.clear();
  }

  function apply(message) {
    if (!message || typeof message.version !== "number" || message.version < lastVersion) return;
    if (message.url && stripHash(message.url) !== stripHash(location.href)) return;
    lastVersion = message.version;
    if (message.state !== "allowed") {
      hold();
    } else {
      release();
    }
  }

  // --- Metadata ----------------------------------------------------------------

  const stripHash = url => String(url).split("#")[0];
  const clean = (text, max) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);

  function metaContent(...names) {
    for (const name of names) {
      const el = document.querySelector(
        `meta[name="${name}" i], meta[property="${name}" i], meta[itemprop="${name}" i]`
      );
      if (el && el.content && el.content.trim()) return el.content.trim();
    }
    return "";
  }

  function readMeta() {
    if (!privacy || privacy.privateUrl(location.href) || privateDocument()) {
      return { url: location.href, privacyProtected: true };
    }
    const meta = privacy.sanitizeMetadata({
      url: location.href,
      title: clean(document.title, 200),
      description: clean(metaContent("description", "og:description", "twitter:description"), 500),
      siteName: clean(metaContent("og:site_name", "application-name"), 80),
      type: clean(metaContent("og:type"), 40),
      keywords: clean(metaContent("keywords"), 300),
      lang: document.documentElement.lang || ""
    });
    // Raw URL is used ONLY to match the sender's navigation, not for inference/storage.
    return { ...meta, url: location.href };
  }

  function privateDocument() {
    // Examine attributes only: never read form values or editor/message text.
    return Boolean(document.querySelector('input[type="password"], [contenteditable="true"], [contenteditable=""], input[autocomplete^="cc-"], input[autocomplete="one-time-code"], [data-private], [data-sensitive]')) ||
      /noindex/i.test(metaContent("robots"));
  }

  function waitFor(check, timeoutMs) {
    return new Promise(resolve => {
      if (check()) return resolve(true);
      const started = Date.now();
      const timer = setInterval(() => {
        if (check() || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(check());
        }
      }, 100);
    });
  }

  async function collect(expectedUrl) {
    if (!privacy || privacy.privateUrl(location.href)) return { url: location.href, privacyProtected: true };
    await waitFor(() => document.readyState !== "loading", 3000);
    if (stripHash(location.href) !== stripHash(expectedUrl)) return { url: location.href };
    if (privateDocument()) return { url: location.href, privacyProtected: true };
    // After in-page navigation the old title lingers for a moment: wait for the new one.
    if (snapshot.url !== location.href && snapshot.title && document.title === snapshot.title) {
      await waitFor(() => document.title !== snapshot.title, 1500);
    }
    const meta = readMeta();
    snapshot = { url: location.href, title: meta.privacyProtected ? "" : meta.title || "" };
    return meta;
  }

  document.addEventListener("DOMContentLoaded", () => {
    snapshot = { url: location.href, title: "" };
  });

  // --- YouTube cleanup ---------------------------------------------------------
  // No hover/scroll link scanning: inference is only for opened pages.
  const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
  // Hard mode has no toggle: remove the most common YouTube rabbit holes.
  if (isYouTube) {
    const cleanYouTube = () => {
      if (document.documentElement && !document.getElementById("focusflow-hard-style")) {
        const style = document.createElement("style");
        style.id = "focusflow-hard-style";
        style.textContent = `#related, ytd-watch-next-secondary-results-renderer, #comments, ytd-comments,
          ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytd-merch-shelf-renderer,
          .ytp-ce-element, .ytp-endscreen-content, .ytp-upnext,
          .ytp-autonav-toggle-button-container, a[href^="/shorts/"] { display: none !important; }`;
        document.documentElement.appendChild(style);
      }
      const autoplay = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
      if (autoplay) autoplay.click();
    };
    let cleanTimer = null;
    new MutationObserver(() => {
      if (!cleanTimer) cleanTimer = setTimeout(() => { cleanTimer = null; cleanYouTube(); }, 250);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked"] });
    cleanYouTube();
  }
  // --- Wiring ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "ff:state") {
      apply(message);
      return false;
    }
    if (message.type === "ff:collect") {
      collect(message.url).then(sendResponse, () => sendResponse(null));
      return true;
    }
    return false;
  });

  async function syncState() {
    if (syncing) return;
    syncing = true;
    try { apply(await chrome.runtime.sendMessage({ type: "ff:hello" })); }
    catch { /* Remain covered; a later hello can wake a restarted worker. */ }
    finally { syncing = false; }
  }

  // Reconnect after bfcache restores and document activation as well as while
  // waiting. Never expose an unchecked page just because the worker stopped.
  window.addEventListener("pageshow", syncState);
  // A local development server is outside the filter, as in policy.decide().
  const local = location.hostname === "localhost" || location.hostname.endsWith(".localhost") ||
    location.hostname === "127.0.0.1" || location.hostname === "[::1]";
  if (!local) hold();
  syncState();
})();
