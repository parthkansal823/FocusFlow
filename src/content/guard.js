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
  const MAX_HOLD_MS = 200000; // fail open only if the background vanished

  let holding = false;
  let lastVersion = -1;
  let cover = null;
  let coverTimer = null;
  let holdTimer = null;
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
          background: #0d1016; color: #eef1f6; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .box { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; padding: 24px; }
        .ring { width: 38px; height: 38px; border-radius: 50%; border: 3px solid #2a303c; border-top-color: #5b8cff;
          animation: spin .9s linear infinite; }
        .title { font-size: 17px; font-weight: 700; }
        .sub { color: #a3acba; max-width: 340px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .ring { animation-duration: 3s; } }
      </style>
      <div class="cover" role="alert" aria-busy="true">
        <div class="box">
          <div class="ring"></div>
          <div class="title">FocusFlow is checking this page</div>
          <div class="sub">The thinking AI is reading its title and description. Study and tech content opens, everything else is blocked.</div>
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
    clearTimeout(holdTimer);
    holdTimer = setTimeout(release, MAX_HOLD_MS);
  }

  function release() {
    clearTimeout(holdTimer);
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
    lastVersion = message.version;
    if (message.state === "pending") {
      hold();
    } else {
      release();
      scheduleVisible();
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

  function jsonLdTypes() {
    const types = new Set();
    const visit = node => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      [].concat(node["@type"] || []).forEach(t => typeof t === "string" && types.add(t));
      if (node["@graph"]) visit(node["@graph"]);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        visit(JSON.parse(script.textContent));
      } catch {
        // ignore broken JSON-LD
      }
    });
    return [...types].slice(0, 5).join(", ");
  }

  function readMeta() {
    const h1 = document.querySelector("h1");
    const root = document.querySelector("main, article, [role=main]") || document.body;
    const snippet = root
      ? [...root.querySelectorAll("p")]
        .slice(0, 8)
        .map(p => clean(p.textContent, 300))
        .filter(t => t.length > 40)
        .join(" ")
      : "";
    return {
      url: location.href,
      title: clean(document.title, 200),
      description: clean(metaContent("description", "og:description", "twitter:description"), 500),
      siteName: clean(metaContent("og:site_name", "application-name"), 80),
      type: clean(metaContent("og:type"), 40),
      keywords: clean(metaContent("keywords"), 300),
      h1: h1 ? clean(h1.textContent, 200) : "",
      jsonLd: jsonLdTypes(),
      snippet: clean(snippet, 400),
      lang: document.documentElement.lang || ""
    };
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
    await waitFor(() => document.readyState !== "loading", 3000);
    if (stripHash(location.href) !== stripHash(expectedUrl)) return { url: location.href };
    // After in-page navigation the old title lingers for a moment: wait for the new one.
    if (snapshot.url !== location.href && snapshot.title && document.title === snapshot.title) {
      await waitFor(() => document.title !== snapshot.title, 1500);
    }
    const meta = readMeta();
    snapshot = { url: location.href, title: document.title };
    return meta;
  }

  document.addEventListener("DOMContentLoaded", () => {
    snapshot = { url: location.href, title: document.title };
  });

  // --- Pre-judging ---------------------------------------------------------------
  // Tell the background which links you'll probably open next, so their verdict
  // is ready before you click: videos on screen (YouTube) and the hovered link.

  const sent = new Set();
  const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
  let visibleTimer = null;
  let hoverTimer = null;

  function prefetch(urls, reason) {
    const fresh = urls.filter(url => {
      if (sent.has(url) || stripHash(url) === stripHash(location.href) || !/^https?:/.test(url)) return false;
      if (sent.size > 500) sent.clear();
      sent.add(url);
      return true;
    });
    if (fresh.length) chrome.runtime.sendMessage({ type: "ff:prefetch", urls: fresh, reason }).catch(() => {});
  }

  function visibleVideoLinks() {
    const ids = new Set();
    const urls = [];
    for (const a of document.querySelectorAll('a[href*="/watch?v="]')) {
      const rect = a.getBoundingClientRect();
      if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const id = new URL(a.href).searchParams.get("v");
      if (!id || ids.has(id)) continue;
      ids.add(id);
      urls.push(`https://www.youtube.com/watch?v=${id}`);
      if (urls.length >= 6) break;
    }
    return urls;
  }

  function scheduleVisible(delay = 800) {
    if (!isYouTube) return;
    clearTimeout(visibleTimer);
    visibleTimer = setTimeout(() => {
      if (!holding) prefetch(visibleVideoLinks(), "visible");
    }, delay);
  }

  document.addEventListener("pointerover", event => {
    const link = event.target instanceof Element && event.target.closest("a[href]");
    if (!link || holding) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => prefetch([link.href], "hover"), 120);
  }, { passive: true, capture: true });

  window.addEventListener("scroll", () => scheduleVisible(1000), { passive: true });

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

  chrome.runtime
    .sendMessage({ type: "ff:hello" })
    .then(apply)
    .catch(() => {}); // extension reloaded or unavailable: do nothing
})();
