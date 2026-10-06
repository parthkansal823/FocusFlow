import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateTab, invalidateContext, invalidateModel, judge, prefetch, queueWrite, resetVerdictCache } from "../../src/background/controller.js";
import { normalizeSettings } from "../../src/shared/store.js";

test("controller fast path opens study and blocks entertainment without network or self-training", async () => {
  const data = { settings: { fastMode: true }, training: [], sites: {
    "mixed.test": { review: { source: "llm", version: 1, type: "mixed", at: Date.now() } },
    "college.test": { allowed: 1, blocked: 0, review: { source: "llm", version: 1, type: "study", at: Date.now() } }
  }, stats: {}, history: [] };
  const tabs = new Map();
  const sent = [], updated = [];
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { local: {
      get: async keys => Object.fromEntries([].concat(keys).map(k => [k, data[k]])),
      set: async patch => Object.assign(data, patch)
    } },
    tabs: {
      get: async id => tabs.get(id),
      sendMessage: async (id, message) => {
        sent.push(message);
        return message.type === "ff:collect" ? tabs.get(id) : undefined;
      },
      update: async (id, change) => updated.push({ id, ...change })
    }
  };
  globalThis.fetch = async () => { throw new Error("Fast path must not use the network"); };
  invalidateContext(); invalidateModel(); resetVerdictCache();
  try {
    assert.deepEqual(await prefetch(["https://mixed.test/lesson"], "hover"), { queued: 0 });
    tabs.set(4, { url: "https://college.test/lesson" });
    await evaluateTab(4, tabs.get(4).url);
    assert.equal(sent.at(-1).state, "allowed");
    assert.equal(sent.filter(message => message.type === "ff:collect").length, 0, "trusted site opens with no DOM scan or AI/network request");
    tabs.set(1, { url: "https://mixed.test/lesson", title: "Binary search explained" });
    await evaluateTab(1, tabs.get(1).url);
    assert.equal(sent.at(-1).state, "allowed");
    assert.equal(sent.at(-1).url, tabs.get(1).url);
    tabs.set(2, { url: "https://mixed.test/fun", title: "Funny cat videos compilation" });
    await evaluateTab(2, tabs.get(2).url);
    assert.equal(updated.length, 1);
    assert.match(updated[0].url, /source=local/);
    assert.equal(data.training.length, 0);
    assert.equal(data.sites["mixed.test"].allowed, undefined, "local guesses cannot teach whole-site trust");

    // An old navigation event must never block the new page already in this tab.
    data.settings = { rules: [{ pattern: "old.test", action: "block" }] };
    invalidateContext();
    tabs.set(3, { url: "https://new.test/lesson" });
    await evaluateTab(3, "https://old.test/fun");
    assert.equal(updated.length, 1);
  } finally {
    await queueWrite(() => {});
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    invalidateContext(); invalidateModel(); resetVerdictCache();
  }
});

test("local AI remains on, but two foreground checks never run inference in parallel", async () => {
  const originalChrome = globalThis.chrome, originalFetch = globalThis.fetch;
  let active = 0, peak = 0, calls = 0;
  const data = {};
  globalThis.chrome = { storage: { local: { set: async patch => Object.assign(data, patch) } } };
  globalThis.fetch = async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"ALLOW","site":"mixed","reason":"Study"}' }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const ctx = { settings: normalizeSettings({ llm: { model: "qwen3:4b" } }) };
    assert.equal(ctx.settings.llm.enabled, true);
    const verdicts = await Promise.all([1, 2].map(id => judge({ url: `https://mixed.test/${id}`, title: "Unclear title" }, {}, ctx, { learn: false })));
    assert.ok(verdicts.every(v => v.source === "llm" && v.verdict === "allow"));
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  } finally {
    await queueWrite(() => {});
    globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;
  }
});
