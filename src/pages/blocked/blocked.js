import { normalizeHost, parseUrl } from "../../shared/rules.js";
import { countForDay } from "../../shared/stats.js";
import { readAll } from "../../shared/store.js";
import { $, sourceLabel } from "../common.js";
import { randomWisdom, roastFor } from "./messages.js";

const params = new URLSearchParams(location.search);
const info = {
  url: params.get("url") || "",
  kind: params.get("kind") || "content",
  reason: params.get("reason") || "",
  source: params.get("source") || "",
  title: params.get("title") || "",
  key: params.get("key") || ""
};
const parsed = parseUrl(info.url);
const host = parsed ? normalizeHost(parsed.hostname) : "";
const isYouTube = /(^|\.)youtube\.com$/.test(host);

// --- What & why ---------------------------------------------------------------

$("#what").textContent = info.title || host || "This page";
$("#host").textContent = info.title ? host : "";
$("#host").hidden = !info.title;
$("#reason").textContent = info.reason;
$("#sourceChip").textContent = sourceLabel(info);
$("#roast").textContent = roastFor({
  site: host,
  title: info.title,
  isVideo: isYouTube,
  isSocial: /reddit|facebook|instagram|x\.com|twitter|threads|snapchat|linkedin/.test(host)
});

const { shlok, motivation } = randomWisdom();
$("#shlok").textContent = shlok[0];
$("#meaning").textContent = shlok[1];
$("#motivation").textContent = motivation;

// --- Actions ---------------------------------------------------------------------

$("#closeTab").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
});

if (isYouTube) {
  $("#ytSearch").hidden = false;
  $("#ytSearch").addEventListener("submit", event => {
    event.preventDefault();
    const query = $("#ytQuery").value.trim();
    if (query) location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  });
}

function showCount(stats) {
  const today = countForDay(stats, Date.now());
  $("#countText").textContent = today ? `Distraction #${today} today` : "Blocked";
}

readAll().then(state => {
  showCount(state.stats);
  $("#backToWork").href = state.settings.studyHomeUrl;
});

// The block is recorded just after this page opens.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) showCount(changes.stats.newValue);
});
