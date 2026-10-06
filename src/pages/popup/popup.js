import { siteType } from "../../shared/policy.js";
import { contentKey, isWebUrl, isYouTubeHost, normalizeHost, parseUrl } from "../../shared/rules.js";
import { countForDay, lastDays } from "../../shared/stats.js";
import { get, KEYS, readAll } from "../../shared/store.js";
import { privateUrl, sanitizeMetadata, storageKey } from "../../shared/privacy.js";
import { $, el, formatTime, llmSummary, send, sourceLabel, toast } from "../common.js";

let activeTab = null;

async function refresh() {
  const [state, verdicts] = await Promise.all([readAll(), get(KEYS.verdictCache, {})]);
  await renderTab(state, verdicts);
  renderStats(state);
  renderJudge(state);
}

async function renderTab(state, verdicts) {
  const chip = $("#tabChip");
  const button = $("#blockTab");
  chip.hidden = true;
  if (!activeTab || !isWebUrl(activeTab.url)) {
    $("#tabTitle").textContent = activeTab ? activeTab.title || "Browser page" : "—";
    $("#tabHost").textContent = "Not a website: nothing to check";
    button.disabled = true;
    return;
  }

  const host = normalizeHost(parseUrl(activeTab.url).hostname);
  const key = await storageKey(contentKey(activeTab.url));
  const meta = sanitizeMetadata({ title: activeTab.title }, activeTab.url);
  $("#tabTitle").textContent = meta.privacyProtected ? "Private page — not scanned" : meta.title || host;
  $("#tabHost").textContent = host;

  const mark = state.overrides[key];
  const verdict = verdicts[key];
  const site = state.sites[host];
  const type = isYouTubeHost(host) ? "" : siteType(site);
  let label = "";
  let tone = "";
  if (mark && mark.verdict === "block") {
    label = mark.verdict === "allow" ? "You marked: study" : "You marked: blocked";
    tone = mark.verdict === "allow" ? "ok" : "danger";
  } else if (verdict) {
    label = verdict.verdict === "allow" ? "Judged: study" : "Judged: blocked";
    tone = verdict.verdict === "allow" ? "ok" : "danger";
  } else if (type) {
    label = `${type[0].toUpperCase()}${type.slice(1)} site`;
    tone = type === "study" ? "ok" : type === "distraction" ? "danger" : "accent";
  }
  if (label) {
    chip.hidden = false;
    chip.className = `chip ${tone}`;
    chip.textContent = label;
    chip.title = (verdict && verdict.reason) || (site && site.reason) || "";
  }
  button.disabled = privateUrl(activeTab.url) || Boolean(mark && mark.verdict === "block");
}

function renderStats({ stats, history }) {
  const now = Date.now();
  $("#todayCount").textContent = countForDay(stats, now);
  $("#totalCount").textContent = stats.total || 0;

  const days = lastDays(now, 7).map(d => ({ ...d, count: (stats.days || {})[d.key] || 0 }));
  const max = Math.max(1, ...days.map(d => d.count));
  $("#weekBars").replaceChildren(
    ...days.map((d, i) =>
      el("div", {
        class: `bar${i === days.length - 1 ? " today" : ""}`,
        style: `height:${Math.max(8, (d.count / max) * 100)}%`,
        title: `${d.date.toLocaleDateString([], { weekday: "short" })}: ${d.count} blocked`
      })
    )
  );

  $("#recentList").replaceChildren(
    ...history.slice(-4).reverse().map(item =>
      el("li", {}, [
        el("span", { class: "time", text: formatTime(item.at) }),
        el("span", { class: "what", title: `${item.url}\n${item.reason || ""}`, text: item.title || item.host }),
        el("span", { class: "chip", text: sourceLabel(item) })
      ])
    )
  );
}

function renderJudge({ settings, llmStatus, sites }) {
  const summary = llmSummary(settings, llmStatus);
  $("#llmChip").className = `chip ${summary.tone}`;
  $("#llmText").textContent = summary.text;
  $("#llmChip").title = summary.detail;
  const learnedSites = Object.values(sites).filter(s => siteType(s)).length;
  $("#learned").textContent =
    `Learned ${learnedSites} site${learnedSites === 1 ? "" : "s"}. Raw page-text training is disabled.`;
}

$("#blockTab").addEventListener("click", async () => {
  if (!activeTab) return;
  const result = await send("ff:mark-distraction", { tabId: activeTab.id });
  if (result && result.ok) {
    toast("Blocked. FocusFlow will remember this.");
    setTimeout(() => window.close(), 900);
  } else {
    toast((result && result.error) || "Could not block this page.");
  }
});

$("#openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") refresh();
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  activeTab = tab || null;
  refresh();
});
