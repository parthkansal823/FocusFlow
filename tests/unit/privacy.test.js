import assert from "node:assert/strict";
import { test } from "node:test";
import { privateNetwork, privateUrl, publicUrl, sanitizeMetadata, storageKey } from "../../src/shared/privacy.js";
import { decide } from "../../src/shared/policy.js";
import { ensurePrivacy, normalizeSettings } from "../../src/shared/store.js";
import { askLlm, buildUserPrompt } from "../../src/background/llm.js";
import { pageFromNet, siteProfileFromNet } from "../../src/background/metadata.js";
import { blockedPageUrl, gatherMetadata, judge, queueWrite } from "../../src/background/controller.js";

const ctx = { settings: normalizeSettings({}), sites: {}, overrides: {} };
test("privacy guard blocks URLs with private routes, services, secrets, credentials and personal identifiers", () => {
  for (const url of ["https://mail.google.com/mail/u/0/#inbox", "https://chatgpt.com/", "https://study.test/account", "https://study.test/auth/callback?code=private", "https://study.test/lesson?access_token=private", "https://study.test/lesson?email=person@example.com", "https://study.test/lesson?q=person%40example.com", "https://person:password@study.test/lesson", "https://study.test/#access_token=secret", "https://study.test/private/record", "https://study.test/records/123e4567-e89b-12d3-a456-426614174000"]) {
    assert.equal(privateUrl(url), true, url);
    assert.equal(decide(url, { ...ctx, sites: { "study.test": { allowed: 1, review: { source: "llm", version: 1, type: "study", at: Date.now() } } } }).reason, "privacy", url);
  }
  for (const url of ["https://docs.python.org/3/", "https://study.test/lesson", "https://www.youtube.com/watch?v=abcdefghijk", "https://study.test/search?q=binary+search"]) assert.equal(privateUrl(url), false, url);
});
test("website metadata requests cannot target IPs, intranet names, plain HTTP or redirects", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    return new Response('<head><title>Binary search</title></head><body><p>PRIVATE_BODY_MARKER</p></body>', { headers: { "content-type": "text/html" } });
  };
  for (const host of ["127.0.0.1", "192.168.1.1", "[::1]", "portal.internal", "device.local", "intranet"]) {
    assert.equal(privateNetwork(host), true);
    assert.equal((await pageFromNet(`https://${host}/`, { fetchImpl })).privacyProtected, true);
  }
  assert.equal(await pageFromNet("http://study.test/", { fetchImpl }), null);
  assert.equal(calls, 0);
  const meta = await pageFromNet("https://study.test/", { fetchImpl });
  assert.equal(meta.title, "Binary search");
  assert.ok(!JSON.stringify(meta).includes("PRIVATE_BODY_MARKER"));
  assert.equal(calls, 1);
});
test("AI payload uses allow-listed metadata, removes URL queries and ignores body/editor text", () => {
  const raw = { url: "https://study.test/lesson?q=private-query#position", title: "Binary search", snippet: "PRIVATE_MESSAGE", h1: "PRIVATE_HEADING", input: "PRIVATE_PASSWORD", description: "Learn algorithms https://example.com/?token=SECRET_LINK" };
  const meta = sanitizeMetadata(raw);
  assert.equal(meta.url, "https://study.test/lesson");
  assert.ok(!JSON.stringify(meta).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(meta).includes("SECRET_LINK"));
  const prompt = buildUserPrompt(raw);
  assert.ok(!prompt.includes("private-query"));
  assert.ok(!prompt.includes("PRIVATE_MESSAGE"));
  assert.ok(!prompt.includes("Main heading"));
  assert.equal(publicUrl("https://youtube.com/watch?v=abcdefghijk&tracking=secret#t=50"), "https://youtube.com/watch?v=abcdefghijk");
});
test("sensitive metadata blocks before local model discovery or any AI request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Must not fetch"); };
  for (const meta of [
    { url: "https://study.test/account", title: "Study" },
    { url: "https://study.test/lesson", title: "Welcome person@example.com" },
    { url: "https://study.test/lesson", description: "api_key=secret" },
    { url: "https://study.test/lesson", privacyProtected: true }
  ]) {
    await assert.rejects(askLlm(meta, ctx.settings.llm, { fetchImpl }), /Private content/);
    assert.equal((await judge(meta, {}, ctx, { learn: false })).source, "privacy");
  }
  assert.equal(calls, 0);
});
test("private-page gathering exits before DOM/network/storage work", async () => {
  const result = await gatherMetadata({}, "https://study.test/inbox?token=private");
  assert.equal(result.privacyProtected, true);
  assert.equal(result.url, "https://study.test/");
});
test("private HTML forms/noindex markers are not classified or saved as homepage profiles", async () => {
  for (const marker of ['<input type="password" value="PRIVATE_PASSWORD">', '<div contenteditable="true">PRIVATE_MESSAGE</div>', '<meta name="robots" content="noindex">']) {
    const fetchImpl = async () => new Response(`<head><title>Binary search</title>${marker}</head>`, { headers: { "content-type": "text/html" } });
    const meta = await pageFromNet("https://study.test/", { fetchImpl });
    assert.equal(meta.privacyProtected, true);
    assert.ok(!JSON.stringify(meta).includes("PRIVATE_"));
    assert.equal(await siteProfileFromNet("study.test", { fetchImpl }), null);
  }
});
test("cache identities are opaque and distinct even when sanitized URLs match", async () => {
  const one = await storageKey("page:study.test/search?q=binary");
  const two = await storageKey("page:study.test/search?q=movies");
  assert.match(one, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(one, two);
  assert.equal(await storageKey(one), one);
  assert.ok(!one.includes("binary"));
});
test("blocked extension URLs contain no private path, query, fragment, title or clear-text cache key", () => {
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: path => `chrome-extension://test/${path}` } };
  try {
  const result = blockedPageUrl({ url: "https://study.test/inbox?token=PRIVATE_TOKEN#PRIVATE_HASH", kind: "privacy", title: "PRIVATE_TITLE", key: "PRIVATE_KEY" });
  assert.ok(!result.includes("PRIVATE"));
  assert.equal(new URL(result).searchParams.get("url"), "https://study.test/");
  } finally { globalThis.chrome = previous; }
});
test("privacy upgrade purges generated raw data and preserves counts, rules and safe hashed block marks", async () => {
  const previous = globalThis.chrome;
  const data = { settings: { rules: [{ pattern: "fun.test", action: "block" }], llm: { apiKey: "OLD_SECRET" } }, stats: { total: 7 }, history: [{ title: "OLD_PRIVATE_TEXT" }], training: [{ text: "OLD_PRIVATE_TEXT" }], verdictCache: { "page:study.test/?token=OLD_SECRET": { title: "OLD_PRIVATE_TEXT" } }, overrides: { "page:study.test/lesson?q=algorithms": { url: "https://study.test/lesson?q=algorithms", title: "OLD_PRIVATE_TEXT", verdict: "block", at: 1 } }, sites: {} };
  let accessLevel;
  globalThis.chrome = { storage: { local: { setAccessLevel: async options => { accessLevel = options.accessLevel; }, get: async keys => Object.fromEntries(keys.map(k => [k, data[k]])), set: async patch => Object.assign(data, patch) } }, runtime: { getURL: path => `chrome-extension://test/${path}` } };
  try {
    await ensurePrivacy();
    assert.equal(accessLevel, "TRUSTED_CONTEXTS");
    assert.equal(data.stats.total, 7);
    assert.equal(data.settings.rules[0].pattern, "fun.test");
    assert.equal(data.settings.llm.apiKey, "");
    assert.deepEqual(data.training, []);
    assert.deepEqual(data.history, []);
    assert.deepEqual(data.verdictCache, {});
    assert.match(Object.keys(data.overrides)[0], /^sha256:/);
    assert.ok(!JSON.stringify(data).includes("OLD_PRIVATE_TEXT"));
    assert.ok(!JSON.stringify(data).includes("OLD_SECRET"));
    const result = blockedPageUrl({ url: "https://study.test/lesson?q=private", title: "Binary search" });
    assert.ok(!result.includes("private"));
    await queueWrite(() => {});
  } finally { globalThis.chrome = previous; }
});
