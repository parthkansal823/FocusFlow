// Client for the LLM judge. Speaks the OpenAI-compatible chat API, which Ollama
// (local), llama.cpp server (our Hugging Face Space) and Groq all expose.
// Thinking is always on (Qwen3's "/think" switch); the prompt asks for brief
// thinking so answers come back fast.

const SYSTEM_PROMPT = `You are FocusFlow, a strict study filter for a computer-science student preparing for software engineering placements.
Only study and tech content may open. Everything else is blocked.

ALLOW only if the content is clearly educational or technical: programming, DSA, competitive programming, system design, CS subjects (OS, DBMS, networks, compilers), software tools and documentation, AI/ML, maths, science and engineering lectures, tech news, placement / interview / career preparation, and the tools a student needs to work (search engine home and results for study topics, email, calendar, documents, notes, online classes, job portals, AI assistants).
BLOCK everything else: entertainment, music and songs, movies, series, trailers, anime, sports and highlights, gaming, vlogs, comedy, pranks, reactions, memes, social feeds, shopping, celebrity or political news, and anything you are unsure about.

Judge this specific page or video from its metadata, not just the website.
Also classify the whole website:
- "study": the site exists for learning, coding or work (e.g. a coding judge, documentation, a course platform).
- "distraction": the site exists mainly for entertainment, social media, streaming, games or shopping.
- "mixed": the site hosts both (video platforms, search engines, forums, blogs, news, encyclopedias, Q&A).

Think briefly: a few short sentences are enough. Then give the final answer as one line of JSON:
{"verdict": "ALLOW" or "BLOCK", "site": "study" or "mixed" or "distraction", "reason": "at most 12 words"}`;

const clip = (text, n) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
};

export class LlmError extends Error {
  constructor(message, { status = 0, kind = "error" } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.kind = kind; // "unreachable" | "timeout" | "auth" | "model" | "bad-answer" | "error"
  }
}

export function buildUserPrompt(meta) {
  const lines = [`Website: ${meta.host || "unknown"}`];
  const site = meta.site;
  if (site && (site.title || site.description)) {
    lines.push(`About the website (its home page): ${clip([site.title, site.description].filter(Boolean).join(" — "), 300)}`);
  }
  lines.push(`URL: ${clip(meta.url, 200)}`);
  const fields = [
    [meta.kind === "youtube" ? "Video title" : "Page title", meta.title || "(unknown)", 200],
    ["Channel", meta.channel, 80],
    ["YouTube category", meta.category, 40],
    ["Page type", [meta.type, meta.jsonLd].filter(Boolean).join(", "), 80],
    ["Main heading", meta.h1 !== meta.title ? meta.h1 : "", 150],
    ["Description", meta.description, 400],
    ["Tags / keywords", meta.keywords, 200],
    ["Text snippet", meta.snippet, 300]
  ];
  for (const [label, value, max] of fields) {
    if (value) lines.push(`${label}: ${clip(value, max)}`);
  }
  lines.push("", "Is this study/tech content? Answer with the JSON line.", "/think");
  return lines.join("\n");
}

export function buildRequest(content, llm) {
  return {
    model: llm.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(content) }
    ],
    // Qwen3 recommends ~0.6 when thinking; greedy decoding can loop.
    temperature: 0.6,
    max_tokens: 1536,
    stream: false
  };
}

export function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "") // unfinished thinking block
    .trim();
}

export function parseAnswer(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const message = choice && choice.message;
  const text = stripThinking(message && message.content);

  const object = text.match(/\{[^{}]*"verdict"[^{}]*\}/i);
  if (object) {
    try {
      const parsed = JSON.parse(object[0]);
      const verdict = String(parsed.verdict || "").toUpperCase();
      if (verdict === "ALLOW" || verdict === "BLOCK") {
        const site = String(parsed.site || "").toLowerCase();
        return {
          verdict: verdict.toLowerCase(),
          site: ["study", "mixed", "distraction"].includes(site) ? site : "",
          reason: String(parsed.reason || "").slice(0, 140)
        };
      }
    } catch {
      // fall back to the plain-text scan below
    }
  }
  const words = text.toUpperCase().match(/\b(ALLOW|BLOCK)\b/g);
  if (words) return { verdict: words[words.length - 1].toLowerCase(), site: "", reason: "" };

  if (choice && choice.finish_reason === "length") {
    throw new LlmError("The model ran out of tokens while thinking", { kind: "bad-answer" });
  }
  throw new LlmError("The model did not answer ALLOW or BLOCK", { kind: "bad-answer" });
}

function endpoint(baseUrl, path) {
  return String(baseUrl || "").replace(/\/+$/, "") + path;
}

function headers(llm) {
  const out = { "Content-Type": "application/json" };
  if (llm.apiKey) out.Authorization = `Bearer ${llm.apiKey}`;
  return out;
}

async function request(url, init, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, credentials: "omit" });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new LlmError(`No answer within ${Math.round(timeoutMs / 1000)}s`, { kind: "timeout" });
    }
    throw new LlmError(`Can't reach ${url.replace(/\/v1\/.*$/, "")} (is the LLM server running?)`, {
      kind: "unreachable"
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errorFor(res, llm) {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      detail = (json.error && (json.error.message || json.error)) || json.message || "";
    } catch {
      detail = body.slice(0, 160);
    }
  } catch {
    // ignore
  }
  detail = String(detail || "").trim();
  if (res.status === 401) return new LlmError("Wrong or missing access token", { status: 401, kind: "auth" });
  if (res.status === 403) {
    return new LlmError(
      "Request refused (403). For Ollama, allow the extension: OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*",
      { status: 403, kind: "auth" }
    );
  }
  if (res.status === 404 && /model/i.test(detail)) {
    return new LlmError(`Model "${llm.model}" not found. For Ollama run: ollama pull ${llm.model}`, {
      status: 404,
      kind: "model"
    });
  }
  if (res.status === 503) return new LlmError("LLM server is starting up, try again soon", { status: 503 });
  return new LlmError(`LLM error ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status });
}

// ---------------------------------------------------------------------------
// Model "auto": use the best thinking model installed on the server.

const MODEL_CACHE_MS = 5 * 60 * 1000;
let resolved = { baseUrl: "", model: "", at: 0 };

/** Higher is better: Qwen3 first (thinks well, follows the JSON format), then bigger. */
export function rankModel(id) {
  const name = String(id || "").toLowerCase();
  if (/embed|rerank|vision|-vl\b|ocr/.test(name)) return -1;
  const size = Number((name.match(/(\d+(?:\.\d+)?)b\b/) || [])[1]) || 0;
  let family = 1;
  if (/coder|code/.test(name)) family = 0; // good at code, not at judging pages
  else if (/qwen3/.test(name)) family = 3;
  else if (/deepseek-r1|qwq|gpt-oss|reasoning|magistral|thinking/.test(name)) family = 2;
  return family * 1000 + Math.min(size, 999) + (/thinking/.test(name) ? 0.5 : 0);
}

export async function resolveModel(llm, { fetchImpl = fetch } = {}) {
  if (llm.model && llm.model !== "auto") return llm.model;
  if (resolved.baseUrl === llm.baseUrl && Date.now() - resolved.at < MODEL_CACHE_MS) return resolved.model;
  const models = (await listModels(llm, { fetchImpl })).filter(id => rankModel(id) >= 0);
  const best = models.sort((a, b) => rankModel(b) - rankModel(a))[0];
  if (!best) {
    throw new LlmError("No model installed. Run scripts/windows/setup-ollama.cmd, or: ollama pull qwen3:4b", {
      kind: "model"
    });
  }
  resolved = { baseUrl: llm.baseUrl, model: best, at: Date.now() };
  return best;
}

/**
 * Ask the LLM whether `content` is study material.
 * @returns {Promise<{verdict: "allow"|"block", site: string, reason: string, model: string}>}
 * @throws {LlmError}
 */
export async function askLlm(content, llm, { fetchImpl = fetch } = {}) {
  const model = await resolveModel(llm, { fetchImpl });
  const res = await request(
    endpoint(llm.baseUrl, "/chat/completions"),
    { method: "POST", headers: headers(llm), body: JSON.stringify(buildRequest(content, { ...llm, model })) },
    llm.timeoutSec * 1000,
    fetchImpl
  );
  if (!res.ok) {
    if (res.status === 404) resolved = { baseUrl: "", model: "", at: 0 }; // model removed: look again
    throw await errorFor(res, { ...llm, model });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new LlmError("LLM server sent something that isn't JSON (is the URL right?)", { kind: "bad-answer" });
  }
  return { ...parseAnswer(json), model };
}

/**
 * Loads the model into memory (Ollama unloads idle models; a GPU load takes a
 * few seconds) and lets the server cache the fixed instructions, so the first
 * real page is judged at full speed. Returns how long it took, in ms.
 */
export async function warmUp(llm, { fetchImpl = fetch } = {}) {
  const started = Date.now();
  const model = await resolveModel(llm, { fetchImpl });
  const body = buildRequest({ host: "example.com", url: "https://example.com/", title: "warm-up" }, { ...llm, model });
  body.max_tokens = 1;
  const res = await request(
    endpoint(llm.baseUrl, "/chat/completions"),
    { method: "POST", headers: headers(llm), body: JSON.stringify(body) },
    Math.max(llm.timeoutSec, 120) * 1000, // the first load from disk can be slow
    fetchImpl
  );
  if (!res.ok) throw await errorFor(res, llm);
  return Date.now() - started;
}

/** Lists model ids served at `baseUrl` (used by the Settings page). */
export async function listModels(llm, { fetchImpl = fetch } = {}) {
  const res = await request(endpoint(llm.baseUrl, "/models"), { headers: headers(llm) }, 8000, fetchImpl);
  if (!res.ok) throw await errorFor(res, llm);
  const json = await res.json();
  return (json.data || json.models || []).map(m => m.id || m.name).filter(Boolean);
}
