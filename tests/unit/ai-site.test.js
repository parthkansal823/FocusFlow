import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, forgetSiteRecord, siteReview, siteType } from "../../src/shared/policy.js";
import { normalizeSettings } from "../../src/shared/store.js";
import { LIMITS } from "../../src/shared/defaults.js";

const ctx = { settings: normalizeSettings({}), overrides: {}, sites: {} };
const reviewed = (type, patch = {}) => ({ allowed: 1, blocked: 0, review: { source: "llm", version: 1, type, at: Date.now(), ...patch } });

test("there is no manual educational allow-list; even famous study sites initially need a verdict", () => {
  for (const url of ["https://docs.python.org/3/", "https://www.khanacademy.org/math", "https://leetcode.com/problems/two-sum", "https://school.test/course"]) {
    assert.equal(decide(url, ctx).action, "check", url);
  }
});

test("one explicit whole-site AI review opens further pages without a scan", () => {
  const sites = { "school.test": reviewed("study") };
  assert.equal(siteType(sites["school.test"]), "study");
  assert.deepEqual(decide("https://school.test/module-2", { ...ctx, sites }), { action: "allow", reason: "site" });
  assert.equal(decide("https://school.test.evil.test/module-2", { ...ctx, sites }).action, "check");
  assert.equal(decide("https://forum.school.test/module-2", { ...ctx, sites }).action, "check");
});

test("mixed, expired or non-AI reviews cannot grant whole-site access", () => {
  for (const record of [reviewed("mixed"), reviewed("study", { at: Date.now() - LIMITS.siteReviewTtlMs - 100 }), reviewed("study", { source: "user" }), reviewed("study", { version: 0 }), { ...reviewed("study"), blocked: 1 }]) {
    assert.notEqual(siteType(record), "study");
    assert.equal(decide("https://school.test/next", { ...ctx, sites: { "school.test": record } }).action, "check");
  }
  assert.equal(siteReview(reviewed("study", { at: Date.now() + 60000 })), null);
});

test("AI site trust cannot override rules/marks/hard surfaces, and Forget removes it", () => {
  const sites = { "school.test": reviewed("study"), "youtube.com": reviewed("study"), "tiktok.com": reviewed("study") };
  const url = "https://school.test/next";
  assert.equal(decide(url, { ...ctx, sites, settings: normalizeSettings({ rules: [{ pattern: "school.test", action: "block" }] }) }).reason, "rule");
  assert.equal(decide(url, { ...ctx, sites, overrides: { "page:school.test/next": { verdict: "block" } } }).reason, "marked");
  assert.equal(decide("https://youtube.com/watch?v=abcdefghijk", { ...ctx, sites }).action, "check");
  assert.equal(decide("https://youtube.com/shorts/abcdefghijk", { ...ctx, sites }).reason, "hard");
  assert.equal(decide("https://tiktok.com/", { ...ctx, sites }).reason, "hard");
  assert.equal(siteReview(forgetSiteRecord(sites["school.test"])), null);
});
