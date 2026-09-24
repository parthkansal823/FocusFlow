import { rankModel } from "../../background/llm.js";
import { LLM_PRESETS, LIMITS } from "../../shared/defaults.js";
import { SITE_EVIDENCE, siteType } from "../../shared/policy.js";
import { formatPattern, parsePattern } from "../../shared/rules.js";
import { emptyStats } from "../../shared/stats.js";
import { KEYS, readAll, saveSettings, set } from "../../shared/store.js";
import { $, el, llmSummary, send, toast } from "../common.js";

let state = null;
let siteFilter = "all";

async function refresh() {
  state = await readAll();
  renderLlmState();
  renderSites();
  renderRules();
  renderMarks();
  renderData();
}

// --- Thinking AI --------------------------------------------------------------

function fillLlmForm() {
  const llm = state.settings.llm;
  $("#baseUrl").value = llm.baseUrl;
  $("#model").value = llm.model;
  $("#apiKey").value = llm.apiKey;
  $("#timeoutSec").value = llm.timeoutSec;
  highlightPreset();
}

function presetFor(url) {
  if (/\.hf\.space/i.test(url)) return "hfSpace";
  if (/localhost|127\.0\.0\.1/i.test(url)) return "ollama";
  return "custom";
}

function highlightPreset() {
  const current = presetFor($("#baseUrl").value);
  document.querySelectorAll(".preset").forEach(b => {
    const active = b.dataset.preset === current;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  });
  $("#helpOllama").open = current === "ollama" && state.llmStatus && state.llmStatus.ok === false;
}

function renderLlmState() {
  const summary = llmSummary(state.settings, state.llmStatus);
  $("#llmState").className = `chip ${summary.tone}`;
  $("#llmStateText").textContent = summary.text;
  $("#llmState").title = summary.detail;
}

function formLlm() {
  return {
    baseUrl: $("#baseUrl").value.trim(),
    model: $("#model").value.trim(),
    apiKey: $("#apiKey").value.trim(),
    timeoutSec: Number($("#timeoutSec").value)
  };
}

async function checkConnection(llm) {
  const out = $("#llmResult");
  out.textContent = "Connecting…";
  const result = await send("ff:list-models", { llm });
  if (!result || !result.ok) {
    out.textContent = `✗ ${(result && result.error) || "Could not connect."}`;
    return null;
  }
  const models = result.models || [];
  $("#modelOptions").replaceChildren(...["auto", ...models].map(id => el("option", { value: id })));
  const best = models.filter(id => rankModel(id) >= 0).sort((a, b) => rankModel(b) - rankModel(a))[0];
  if (!models.length) {
    out.textContent = "Connected, but no model is installed. Run: ollama pull qwen3:4b";
  } else if (llm.model === "auto") {
    out.textContent = `✓ Connected · auto uses the best installed model: ${best || models[0]}`;
  } else if (models.some(id => id === llm.model || id.split(":")[0] === llm.model)) {
    out.textContent = `✓ Connected · ${models.length} model${models.length === 1 ? "" : "s"} available`;
  } else {
    out.textContent = `Connected, but "${llm.model}" isn't installed. Available: ${models.slice(0, 5).join(", ")}`;
  }
  return models;
}

const HELP = { ollama: "#helpOllama", hfSpace: "#helpHf", custom: "#helpCustom" };

document.querySelectorAll(".preset").forEach(button =>
  button.addEventListener("click", () => {
    const preset = LLM_PRESETS[button.dataset.preset];
    if (preset) {
      $("#baseUrl").value = preset.baseUrl;
      $("#model").value = preset.model;
    } else {
      $("#baseUrl").value = "http://";
      $("#baseUrl").focus();
    }
    highlightPreset();
    document.querySelectorAll(".preset").forEach(b => b.classList.toggle("active", b === button));
    $(HELP[button.dataset.preset]).open = true;
  })
);

$("#baseUrl").addEventListener("input", highlightPreset);

$("#detectModels").addEventListener("click", async () => {
  const models = await checkConnection(formLlm());
  const current = $("#model").value.trim();
  if (models && models.length && current !== "auto" && !models.includes(current)) $("#model").value = "auto";
});

$("#llmForm").addEventListener("submit", async event => {
  event.preventDefault();
  const llm = formLlm();
  state.settings = await saveSettings({ llm });
  toast("Saved");
  await checkConnection(state.settings.llm);
});

// --- Test a page ---------------------------------------------------------------

const VERDICT_TEXT = { allow: "Opens", block: "Blocked" };

function verdictCard(label, verdict, detail) {
  return el("div", { class: `verdict ${verdict || ""}` }, [
    el("span", { class: "verdict-label", text: label }),
    el("span", { class: "verdict-value", text: VERDICT_TEXT[verdict] || "—" }),
    el("span", { class: "muted", text: detail || "" })
  ]);
}

function metaRows(result) {
  const m = result.meta;
  const rows = [
    ["Title", m.title],
    ["Channel", m.channel],
    ["YouTube category", m.category],
    ["Description", m.description],
    ["Tags / keywords", m.keywords],
    ["Page type", [m.type, m.jsonLd].filter(Boolean).join(", ")],
    ["Main heading", m.h1],
    ["About the site", result.site ? [result.site.title, result.site.description].filter(Boolean).join(" — ") : ""]
  ].filter(([, value]) => value);
  if (!rows.length) rows.push(["Metadata", "Nothing could be read (page may need a login or block bots)."]);
  return el("table", { class: "meta-table" }, [
    el("tbody", {}, rows.map(([k, v]) => el("tr", {}, [el("th", { text: k }), el("td", { text: String(v).slice(0, 400) })])))
  ]);
}

$("#testForm").addEventListener("submit", async event => {
  event.preventDefault();
  const box = $("#testResult");
  box.hidden = false;
  box.replaceChildren(el("p", {
    class: "muted",
    text: "Reading metadata and asking the thinking AI…"
  }));
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const result = await send("ff:test-url", { url: $("#testUrl").value });
    if (!result || !result.ok) {
      box.replaceChildren(el("p", { class: "muted", text: `✗ ${(result && result.error) || "Test failed."}` }));
      return;
    }
    const llm = result.llm;
    const llmCard = llm.ok
      ? verdictCard("Thinking AI", llm.verdict, `${llm.reason || ""}${llm.site ? ` · site: ${llm.site}` : ""} · ${(llm.ms / 1000).toFixed(1)}s`)
      : verdictCard("Thinking AI", "", `✗ ${llm.error}`);
    box.replaceChildren(
      el("div", { class: "verdicts" }, [
        llmCard,
        verdictCard("Offline model", result.offline.verdict, result.offline.reason)
      ]),
      metaRows(result)
    );
  } finally {
    if (button) button.disabled = false;
  }
});

// --- Learned sites -------------------------------------------------------------

const SITE_TONE = { study: "ok", mixed: "accent", distraction: "danger", learning: "" };

function evidence(site) {
  const parts = [`${site.blocked || 0} blocked`, `${site.allowed || 0} study`];
  return [parts.join(" · "), site.reason].filter(Boolean).join(" · ");
}

function renderSites() {
  const learned = Object.entries(state.sites)
    .filter(([, s]) => s.allowed || s.blocked)
    .map(([host, s]) => [host, s, siteType(s) || "learning"])
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  $("#siteCount").textContent = learned.length ? `${learned.length} seen` : "";
  const shown = learned.filter(([, , type]) => siteFilter === "all" || type === siteFilter);
  $("#siteEmpty").hidden = learned.length > 0;
  $("#siteList").replaceChildren(
    ...shown.map(([host, site, type]) =>
      el("li", {}, [
        el("div", { class: "item-main" }, [
          el("div", { class: "item-title mono", text: host }),
          el("div", { class: "item-sub", text: evidence(site) })
        ]),
        el("span", {
          class: `chip ${SITE_TONE[type]}`,
          text: type,
          title: type === "learning" ? `Judged page by page until ${SITE_EVIDENCE} pages agree` : ""
        }),
        el("button", {
          class: "link-btn",
          type: "button",
          text: "Forget",
          title: "Judge this site again next time",
          onclick: async () => {
            await send("ff:forget-site", { host });
            toast(`${host} will be judged again`);
          }
        })
      ])
    )
  );
}

$("#siteFilter").addEventListener("click", event => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  siteFilter = tab.dataset.filter;
  document.querySelectorAll("#siteFilter .tab").forEach(t => t.classList.toggle("active", t === tab));
  renderSites();
});

// --- Your rules -----------------------------------------------------------------

function renderRules() {
  $("#ruleList").replaceChildren(
    ...state.settings.rules.map(rule =>
      el("li", {}, [
        el("div", { class: "item-main" }, [el("div", { class: "item-title mono", text: rule.pattern })]),
        el("span", {
          class: `chip ${rule.action === "allow" ? "ok" : "danger"}`,
          text: rule.action === "allow" ? "always allow" : "always block"
        }),
        el("button", {
          class: "icon-btn",
          type: "button",
          title: `Remove ${rule.pattern}`,
          "aria-label": `Remove ${rule.pattern}`,
          text: "×",
          onclick: async () => {
            state.settings = await saveSettings({ rules: state.settings.rules.filter(r => r.pattern !== rule.pattern) });
            renderRules();
          }
        })
      ])
    )
  );
}

$("#addRuleForm").addEventListener("submit", async event => {
  event.preventDefault();
  const parsed = parsePattern($("#newPattern").value);
  if (!parsed) {
    toast("That doesn't look like a site, e.g. example.com or example.com/path");
    return;
  }
  const pattern = formatPattern(parsed);
  const rules = [...state.settings.rules.filter(r => r.pattern !== pattern), { pattern, action: $("#newAction").value }];
  state.settings = await saveSettings({ rules });
  $("#newPattern").value = "";
  renderRules();
  toast(`Added ${pattern}`);
});

// --- Marks ------------------------------------------------------------------------

function renderMarks() {
  const marks = Object.entries(state.overrides).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  $("#markEmpty").hidden = marks.length > 0;
  $("#markList").replaceChildren(
    ...marks.map(([key, mark]) =>
      el("li", {}, [
        el("div", { class: "item-main" }, [
          el("div", { class: "item-title", text: mark.title || mark.url }),
          el("div", { class: "item-sub", text: mark.url })
        ]),
        el("span", {
          class: `chip ${mark.verdict === "allow" ? "ok" : "danger"}`,
          text: mark.verdict === "allow" ? "study" : "blocked"
        }),
        el("button", {
          class: "icon-btn",
          type: "button",
          title: "Remove mark",
          "aria-label": "Remove mark",
          text: "×",
          onclick: () => send("ff:remove-mark", { key })
        })
      ])
    )
  );
}

// --- Data -----------------------------------------------------------------------

function renderData() {
  const learnedSites = Object.values(state.sites).filter(s => siteType(s)).length;
  const fromAi = state.training.filter(e => e.source === "llm").length;
  const fromYou = state.training.filter(e => e.source === "user").length;
  $("#dataSummary").textContent =
    `${learnedSites} learned sites · ${fromAi} examples from the AI · ${fromYou} from you · ` +
    `${state.stats.total || 0} pages blocked in total. Study marks: ${LIMITS.studyMarksPerDay} per day.`;
}

$("#resetLearning").addEventListener("click", async () => {
  if (!confirm("Forget all learned sites and remembered AI verdicts? Your own marks are kept.")) return;
  await send("ff:reset-learning");
  toast("Forgotten. Pages will be judged again.");
});

$("#resetStats").addEventListener("click", async () => {
  if (!confirm("Reset blocked counts and history?")) return;
  await set({ [KEYS.stats]: emptyStats(), [KEYS.history]: [] });
  toast("Stats reset");
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") refresh();
});

refresh().then(fillLlmForm);
