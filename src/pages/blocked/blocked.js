import { LIMITS } from "../../shared/defaults.js";
import { studyMarksToday } from "../../shared/policy.js";
import { normalizeHost, parseUrl } from "../../shared/rules.js";
import { countForDay } from "../../shared/stats.js";
import { readAll } from "../../shared/store.js";
import { $, send, sourceLabel } from "../common.js";
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
const APPEAL_PHRASE = "i am here to study";

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

// "This is study content": only for pages the AI/offline model judged, never for
// your own rules, marks or learned distraction sites. Limited per day, with a wait.
function setupAppeal(overrides) {
  if (info.kind !== "content" || !info.key || !info.url) {
    const note = $("#lockedNote");
    note.hidden = false;
    note.textContent = info.kind === "site"
      ? "Whole site blocked. If FocusFlow got this site wrong, use \"Forget\" under Learned sites in Settings."
      : info.kind === "rule"
        ? "Blocked by one of your rules (Settings → Your rules)."
        : "You marked this page as a distraction.";
    return;
  }

  const left = LIMITS.studyMarksPerDay - studyMarksToday(overrides);
  const appeal = $("#appeal");
  appeal.hidden = false;
  if (left <= 0) {
    $("#appealInfo").textContent = `You've used all ${LIMITS.studyMarksPerDay} study marks for today. Come back tomorrow, or open a different lecture.`;
    $("#appealForm").hidden = true;
    return;
  }
  $("#appealInfo").textContent =
    `If the AI got it wrong, you can open this exact page. ${left} of ${LIMITS.studyMarksPerDay} left today. ` +
    "It also teaches FocusFlow for next time.";

  let started = false;
  appeal.addEventListener("toggle", () => {
    if (!appeal.open || started) return;
    started = true;
    let wait = LIMITS.studyMarkWaitSec;
    const button = $("#appealSubmit");
    const tick = () => {
      if (wait > 0) {
        button.textContent = `Wait ${wait}s`;
        wait -= 1;
        setTimeout(tick, 1000);
      } else {
        button.textContent = "Open page";
        button.disabled = false;
        $("#appealInput").disabled = false;
        $("#appealInput").focus();
      }
    };
    tick();
  });

  $("#appealForm").addEventListener("submit", async event => {
    event.preventDefault();
    const typed = $("#appealInput").value.trim().toLowerCase().replace(/\s+/g, " ");
    if (typed !== APPEAL_PHRASE) {
      $("#appealError").textContent = "Type the sentence exactly.";
      return;
    }
    const result = await send("ff:mark-study", { key: info.key, url: info.url, title: info.title });
    if (result && result.ok) location.href = info.url;
    else $("#appealError").textContent = (result && result.error) || "Could not open the page.";
  });
}

function showCount(stats) {
  const today = countForDay(stats, Date.now());
  $("#countText").textContent = today ? `Distraction #${today} today` : "Blocked";
}

readAll().then(state => {
  showCount(state.stats);
  $("#backToWork").href = state.settings.studyHomeUrl;
  setupAppeal(state.overrides);
});

// The block is recorded just after this page opens.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) showCount(changes.stats.newValue);
});
