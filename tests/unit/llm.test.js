import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askLlm, buildRequest, buildUserPrompt, listModels, parseAnswer, rankModel, resolveModel, stripThinking, warmUp
} from "../../src/background/llm.js";
import { normalizeLlm } from "../../src/shared/store.js";

const llm = normalizeLlm({ model: "qwen3:1.7b" });
const meta = {
  kind: "youtube",
  host: "youtube.com",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  title: "Binary Search in one shot",
  channel: "take U forward",
  category: "Education",
  description: "Learn binary search with 10 problems."
};
const reply = (content, extra = {}) => ({ choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: "stop" }] });

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, json, text } = await handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => (text !== undefined ? text : JSON.stringify(json))
    };
  };
  impl.calls = calls;
  return impl;
}

test("defaults: local AI on with automatic installed-model selection", () => {
  const defaults = normalizeLlm({});
  assert.equal(defaults.baseUrl, "http://localhost:11434/v1");
  assert.equal(defaults.model, "auto");
  assert.equal(defaults.enabled, true);
});

test("rankModel prefers smaller Qwen3 models and excludes embeddings/vision/cloud", () => {
  const installed = [
    "llama3.2:3b", "qwen3:1.7b", "qwen3:4b", "nomic-embed-text:latest", "qwen3-coder:30b",
    "deepseek-r1:8b", "qwen3-embedding:4b", "qwen3:8b"
  ];
  const ranked = installed.filter(id => rankModel(id) >= 0).sort((a, b) => rankModel(b) - rankModel(a));
  assert.deepEqual(ranked.slice(0, 4), ["qwen3:1.7b", "qwen3:4b", "qwen3:8b", "deepseek-r1:8b"]);
  assert.ok(rankModel("nomic-embed-text:latest") < 0);
  assert.ok(rankModel("qwen3-embedding:4b") < 0);
  assert.ok(rankModel("qwen3-coder:30b") < rankModel("qwen3:1.7b"));
  assert.ok(rankModel("qwen3:4b-thinking-2507-q4_K_M") < rankModel("qwen3:4b"));
  assert.ok(rankModel("qwen3:4b-cloud") < 0);
});

test("model 'auto' asks the server what's installed and uses the best", async () => {
  const fetchImpl = fakeFetch(url =>
    url.endsWith("/models")
      ? { json: { data: [{ id: "llama3.2:3b" }, { id: "qwen3:4b" }, { id: "qwen3:1.7b" }] } }
      : { json: reply('{"verdict":"ALLOW","site":"mixed","reason":"Lecture"}') }
  );
  const auto = normalizeLlm({ baseUrl: "http://localhost:18001/v1", model: "auto" });
  const result = await askLlm(meta, auto, { fetchImpl });
  assert.equal(result.model, "qwen3:1.7b");
  assert.equal(fetchImpl.calls.find(c => c.url.endsWith("/chat/completions")).body.model, "qwen3:1.7b");

  // Remembered for a while: the next question doesn't list models again.
  await askLlm(meta, auto, { fetchImpl });
  assert.equal(fetchImpl.calls.filter(c => c.url.endsWith("/models")).length, 1);

  // Warm-up loads that model with a 1-token request.
  await warmUp(auto, { fetchImpl });
  const warm = fetchImpl.calls.at(-1);
  assert.equal(warm.body.model, "qwen3:1.7b");
  assert.equal(warm.body.max_tokens, 1);
});

test("model 'auto' with nothing installed explains what to do", async () => {
  const fetchImpl = fakeFetch(() => ({ json: { data: [{ id: "nomic-embed-text" }] } }));
  await assert.rejects(
    resolveModel(normalizeLlm({ baseUrl: "http://localhost:18002/v1", model: "auto" }), { fetchImpl }),
    /No model installed.*qwen3:1.7b/
  );
});

test("prompt carries metadata and disables reasoning for low latency", () => {
  const prompt = buildUserPrompt({ ...meta, site: { title: "YouTube", description: "Share videos" } });
  assert.match(prompt, /Video title: Binary Search in one shot/);
  assert.match(prompt, /YouTube category: Education/);
  assert.match(prompt, /Channel: take U forward/);
  assert.match(prompt, /About the website/);
  assert.match(prompt, /\/no_think$/);

  const request = buildRequest(meta, llm);
  assert.equal(request.max_tokens, 128);
  assert.equal(request.stream, true);
  assert.equal(request.reasoning_effort, "none");
  assert.match(request.messages[0].content, /untrusted data/);
});

test("parseAnswer reads JSON, ignores the thinking, and falls back to plain words", () => {
  assert.deepEqual(parseAnswer(reply('{"verdict":"ALLOW","site":"mixed","reason":"DSA lecture"}')), {
    verdict: "allow", site: "mixed", wholeSiteStudy: false, reason: "DSA lecture"
  });
  const withThinking = reply('<think>It mentions a movie, so BLOCK? No, ALLOW...</think>\n{"verdict": "BLOCK", "site": "distraction", "reason": "Movie trailer"}');
  assert.equal(parseAnswer(withThinking).verdict, "block");
  assert.equal(parseAnswer(withThinking).site, "distraction");
  assert.equal(parseAnswer(reply("Verdict: ALLOW")).verdict, "allow");
  assert.equal(parseAnswer(reply('{"verdict":"ALLOW","site":"weird"}')).site, "");
  assert.throws(() => parseAnswer(reply("I am not sure")), /did not answer/);
  assert.throws(
    () => parseAnswer({ choices: [{ message: { content: "<think>long..." }, finish_reason: "length" }] }),
    /ran out of tokens/
  );
  assert.equal(stripThinking("<think>a</think>b"), "b");
  assert.equal(parseAnswer(reply('{"verdict":"ALLOW","site":"study","whole_site_study":true}')).wholeSiteStudy, true);
  assert.equal(parseAnswer(reply('{"verdict":"ALLOW","site":"study","whole_site_study":"true"}')).wholeSiteStudy, false);
});

test("askLlm posts an OpenAI-compatible request", async () => {
  const fetchImpl = fakeFetch(() => ({ json: reply('{"verdict":"ALLOW","site":"mixed","reason":"Lecture"}') }));
  const result = await askLlm(meta, { ...llm, apiKey: "secret" }, { fetchImpl });
  assert.equal(result.verdict, "allow");
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(call.init.headers.Authorization, undefined, "Ollama requests never transmit authentication secrets");
  assert.equal(call.init.redirect, "error", "localhost cannot redirect metadata to a remote AI server");
  assert.equal(call.body.model, "qwen3:1.7b");
  assert.equal(call.body.messages[0].role, "system");
});

test("askLlm explains common failures", async () => {
  const cases = [
    [{ status: 401, json: { error: "unauthorized" } }, /access token/],
    [{ status: 403, text: "" }, /OLLAMA_ORIGINS/],
    [{ status: 404, json: { error: { message: 'model "qwen3:1.7b" not found' } } }, /ollama pull qwen3:1.7b/],
    [{ status: 503, text: "" }, /starting up/],
    [{ status: 200, text: "<html>" }, /isn't JSON/]
  ];
  for (const [response, pattern] of cases) {
    const fetchImpl = fakeFetch(() => ({ ...response, json: response.json }));
    if (response.text === "<html>") {
      fetchImpl.calls.length = 0;
      const broken = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } });
      await assert.rejects(askLlm(meta, llm, { fetchImpl: broken }), pattern);
      continue;
    }
    await assert.rejects(askLlm(meta, llm, { fetchImpl }), pattern);
  }

  const down = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(askLlm(meta, llm, { fetchImpl: down }), err => err.kind === "unreachable");

  const slow = (_url, init) => new Promise((_, reject) =>
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
  );
  await assert.rejects(askLlm(meta, { ...llm, timeoutSec: 0.05 }, { fetchImpl: slow }), /No answer within/);
});

test("listModels understands OpenAI-style model lists", async () => {
  const fetchImpl = fakeFetch(() => ({ json: { data: [{ id: "qwen3:1.7b" }, { id: "llama3.2" }] } }));
  assert.deepEqual(await listModels(llm, { fetchImpl }), ["qwen3:1.7b", "llama3.2"]);
  assert.equal(fetchImpl.calls[0].url, "http://localhost:11434/v1/models");
});

test("oversized JSON and unterminated SSE responses are rejected rather than buffered indefinitely", async () => {
  for (const type of ["application/json", "text/event-stream"]) {
    const fetchImpl = async () => new Response("x".repeat(256001), { headers: { "content-type": type } });
    await assert.rejects(askLlm(meta, llm, { fetchImpl }), /response is too large/);
  }
});

test("direct AI requests reject hosted URLs and cloud models before any fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Must not fetch"); };
  const remote = { ...llm, baseUrl: "https://example.com/v1" };
  await assert.rejects(askLlm(meta, remote, { fetchImpl }), /Only a local AI server/);
  await assert.rejects(listModels(remote, { fetchImpl }), /Only a local AI server/);
  await assert.rejects(askLlm(meta, { ...llm, model: "gemma4:cloud" }, { fetchImpl }), /not a cloud model/);
  assert.equal(calls, 0);
});

test("streamed chunks can split lines and Unicode; reasoning is not a verdict", async () => {
  const encoded = new TextEncoder().encode([
    ': keepalive\r\n\r\n',
    'data: {"choices":[{"delta":{"reasoning_content":"BLOCK"}}]}\r\n\r\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: '{"verdict":"ALLOW","site":"mixed","reason":"पढ़ाई"}' } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ].join(''));
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
  const result = await askLlm(meta, llm, { fetchImpl });
  assert.equal(result.verdict, "allow");
  assert.equal(result.reason, "पढ़ाई");
});

test("timeout also aborts a response body after headers arrived", async () => {
  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    }
  }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(askLlm(meta, { ...llm, timeoutSec: 0.05 }, { fetchImpl }), error => error.kind === "timeout");
});

test("malformed and truncated streams cannot allow an unchecked page", async () => {
  for (const stream of ['data: invalid\n\n', 'data: {"choices":[{"delta":{"reasoning_content":"ALLOW"},"finish_reason":"length"}]}\n\n']) {
    const fetchImpl = async () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
    await assert.rejects(askLlm(meta, llm, { fetchImpl }), error => error.kind === "bad-answer");
  }
});
