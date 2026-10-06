// Small helpers shared by the extension pages.

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

let toastTimer = null;
export function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = el("div", { class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 1800);
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function formatTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const SOURCE_LABELS = {
  llm: "Local AI",
  local: "Fast local classifier",
  hard: "Hard mode",
  offline: "Offline model",
  site: "Learned site",
  rule: "Your rule",
  marked: "Your mark",
  error: "Unverified"
};

// Label for a blocked-page / history entry.
export function sourceLabel(entry) {
  if (entry.kind === "marked") return SOURCE_LABELS.marked;
  return SOURCE_LABELS[entry.source] || "Blocked";
}

export function llmSummary(settings, llmStatus) {
  const llm = settings.llm;
  if (!llm.enabled) return { tone: "ok", text: "Lightweight · no AI server", detail: "Hard mode on. Bundled text classifier; no inference model loaded." };
  if (llmStatus && llmStatus.ok === false) {
    return { tone: "danger", text: "LLM unreachable · offline model", detail: llmStatus.error || "" };
  }
  // With model "auto", show the model that actually answered.
  const model = llm.model === "auto" && llmStatus && llmStatus.model ? llmStatus.model : llm.model;
  return { tone: "ok", text: `${model} · ${settings.fastMode ? "fast mode" : "AI checks"}`, detail: llm.baseUrl };
}
