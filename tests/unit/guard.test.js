import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../src/shared/privacy-core.js", import.meta.url), "utf8") + "\n" +
  readFileSync(new URL("../../src/content/guard.js", import.meta.url), "utf8");
function harness({ privateForm = false } = {}) {
  const timers = new Map(), intervals = new Map(), children = new Set();
  let nextTimer = 0, listener, answer = null, calls = 0;
  const url = "https://study.test/lesson";
  const document = {
    title: "Binary search explained", readyState: "complete",
    addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [],
    querySelector: selector => {
      if (/^h1$|main|article|\[role=main\]|^p$/.test(selector)) throw new Error("Must not read body content");
      return privateForm && selector.startsWith('input[type="password"]') ? {} : null;
    },
    documentElement: { lang: "en", appendChild: element => children.add(element) },
    createElement: () => ({ attachShadow: () => ({}), remove() { children.delete(this); } })
  };
  runInNewContext(source, {
    URL, window: { addEventListener() {} }, location: { href: url, hostname: "study.test" }, document,
    chrome: { runtime: {
      sendMessage: async () => { calls++; if (!answer) throw new Error("worker unavailable"); return answer; },
      onMessage: { addListener: callback => { listener = callback; } }
    } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id)
  });
  return {
    children, intervals, url, calls: () => calls,
    respond: value => { answer = value; },
    push: message => listener({ type: "ff:state", ...message }),
    collect: () => new Promise(resolve => listener({ type: "ff:collect", url }, {}, resolve)),
    cover: () => { for (const { fn, ms } of timers.values()) if (ms === 300) fn(); }
  };
}

test("guard holds immediately, ignores another URL's verdict, and stays held on worker failure", async () => {
  const guard = harness();
  await new Promise(resolve => setImmediate(resolve));
  guard.cover();
  assert.equal(guard.children.size, 1);
  guard.push({ state: "allowed", version: 900, url: "https://old.test/" });
  assert.equal(guard.children.size, 1);
  guard.push({ state: "pending", version: 100, url: guard.url });
  guard.push({ state: "allowed", version: 99, url: guard.url });
  assert.equal(guard.children.size, 1);
  assert.equal(guard.intervals.size, 1);
  assert.equal([...guard.intervals.values()][0].ms, 10_000);
});

test("guard reads metadata only, never paragraphs, headings or form values", async () => {
  const meta = await harness().collect();
  assert.equal(meta.title, "Binary search explained");
  assert.equal(meta.snippet, undefined);
  assert.equal(meta.h1, undefined);
  assert.equal(meta.jsonLd, undefined);
});

test("guard with a private form returns only a protected marker", async () => {
  const meta = await harness({ privateForm: true }).collect();
  assert.equal(meta.privacyProtected, true);
  assert.equal(meta.title, undefined);
  assert.equal(meta.description, undefined);
});

test("guard reconnects to a restarted worker and releases only on an allowed verdict", async () => {
  const guard = harness();
  await new Promise(resolve => setImmediate(resolve));
  guard.cover();
  guard.push({ state: "pending", version: 100, url: guard.url });
  guard.respond({ state: "allowed", version: 101, url: guard.url });
  await [...guard.intervals.values()][0].fn();
  assert.equal(guard.children.size, 0);
  assert.equal(guard.intervals.size, 0);
  assert.ok(guard.calls() >= 2);
});
