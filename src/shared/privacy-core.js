// Bundled classic script shared by the isolated content world and ES modules.
// This is a privacy deny guard, NOT a manually curated educational allow-list.
(() => {
  "use strict";
  if (globalThis.FocusFlowPrivacy) return;
  const PRIVATE_HOST = /^(?:mail|webmail|outlook|accounts?|login|auth|identity|banking|netbanking|payments?)\./i;
  const PRIVATE_SERVICES = /(?:^|\.)(?:gmail\.com|proton\.me|protonmail\.com|icloud\.com|whatsapp\.com|telegram\.org|messenger\.com|chatgpt\.com|claude\.ai)$/i;
  const PRIVATE_PATH = /(?:^|\/)(?:inbox|compose|mail|messages?|chats?|conversations?|account|settings|billing|checkout|payments?|wallet|banking|patient|medical-records|health-records|login|signin|sign-in|oauth2?|authorize|callback|reset-password|password-reset|private|edit)(?:\/|$)/i;
  const SECRET_PARAM = /(?:token|secret|password|passwd|credential|session|auth|nonce|code_verifier|api[_-]?key|access[_-]?key|signature|signed|email|phone|address|ssn|patient|account[_-]?id)|^(?:code|state|jwt|csrf|sid|otp|pin)$/i;
  const PERSONAL_TEXT = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d[ -]?){13,19}\b|\b(?:\d{3}[- ]\d{2}[- ]\d{4})\b|\b(?:bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/i;
  const SECRET_TEXT = /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|session[_ -]?id|client[_ -]?secret)\s*[:=]\s*\S+/i;
  const REASON = "Private or sensitive content is not scanned. Hard mode cannot verify this page safely.";
  const parse = value => { try { return new URL(value); } catch { return null; } };
  function sensitiveText(value) {
    const text = String(value || "");
    return PERSONAL_TEXT.test(text) || SECRET_TEXT.test(text);
  }
  function privateNetwork(host) {
    const h = host.toLowerCase().replace(/\.$/, "");
    // Never make auxiliary website requests to local/intranet/IP destinations.
    return !h.includes(".") || h.includes(":") || /^\[/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/.test(h);
  }
  function privateUrl(value) {
    const u = parse(value);
    if (!u || !/^https?:$/.test(u.protocol)) return true;
    if (privateNetwork(u.hostname) || u.username || u.password || PRIVATE_HOST.test(u.hostname) || PRIVATE_SERVICES.test(u.hostname)) return true;
    let path;
    try { path = decodeURIComponent(u.pathname); } catch { return true; }
    if (PRIVATE_PATH.test(path) || sensitiveText(path) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(path)) return true;
    // Hashes can contain OAuth responses, SPA message IDs and embedded secrets.
    let hash;
    try { hash = decodeURIComponent(u.hash); } catch { return true; }
    if (PRIVATE_PATH.test(hash.replace(/^#/, "")) || sensitiveText(hash) || SECRET_PARAM.test(hash)) return true;
    for (const [key, text] of u.searchParams) {
      if (SECRET_PARAM.test(key) || sensitiveText(text) || text.length > 256) return true;
    }
    return false;
  }
  function publicUrl(value, { originOnly = false } = {}) {
    const u = parse(value);
    if (!u || !/^https?:$/.test(u.protocol)) return "";
    const origin = `${u.protocol}//${u.host}`; // URL.origin would preserve neither userinfo nor path.
    if (originOnly || privateUrl(value)) return `${origin}/`;
    let query = "";
    // Only a public video identity survives. Search terms and all other query values do not.
    if (/(?:^|\.)youtube\.com$/i.test(u.hostname) && u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) query = `?v=${id}`;
    }
    return `${origin}${u.pathname}${query}`;
  }
  function protectedMeta(value) {
    return { url: publicUrl(value, { originOnly: true }), privacyProtected: true, privacyReason: REASON };
  }
  function sanitizeMetadata(meta = {}, expectedUrl = meta.url) {
    if (meta.privacyProtected || privateUrl(expectedUrl)) return protectedMeta(expectedUrl);
    const fields = { title: 200, description: 400, siteName: 80, type: 40, keywords: 200, channel: 80, category: 40, lang: 20 };
    const out = { url: publicUrl(expectedUrl), host: parse(expectedUrl)?.hostname.replace(/^www\./, "") || "", kind: meta.kind === "youtube" ? "youtube" : "page" };
    for (const [key, max] of Object.entries(fields)) {
      const raw = String(meta[key] || "").slice(0, 4096);
      if (sensitiveText(raw)) return protectedMeta(expectedUrl);
      out[key] = raw.replace(/https?:\/\/[^\s<>"']+/gi, "[link]").replace(/\s+/g, " ").trim().slice(0, max);
    }
    // Never accept body snippets, headings, JSON-LD objects or arbitrary new fields.
    if (meta.site) {
      const siteUrl = `${parse(expectedUrl)?.origin}/`;
      const site = sanitizeMetadata({ title: meta.site.title, description: meta.site.description, siteName: meta.site.siteName }, siteUrl);
      if (!site.privacyProtected) out.site = { title: site.title, description: site.description, siteName: site.siteName };
    }
    return out;
  }
  Object.defineProperty(globalThis, "FocusFlowPrivacy", { value: Object.freeze({
    REASON, privateUrl, privateNetwork, sensitiveText, publicUrl, protectedMeta, sanitizeMetadata
  }) });
})();
