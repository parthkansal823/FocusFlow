import assert from "node:assert/strict";
import { test } from "node:test";
import { appendHistory, countForDay, lastDays, localDateKey, recordBlock } from "../../src/shared/stats.js";
import { isLocalAiUrl, normalizeLlm, normalizeSettings } from "../../src/shared/store.js";

test("recordBlock counts per local day and keeps 30 days", () => {
  const now = new Date(2026, 8, 24, 0, 30).getTime(); // 00:30 local
  let stats = recordBlock(null, now);
  stats = recordBlock(stats, now);
  assert.equal(stats.total, 2);
  assert.equal(countForDay(stats, now), 2);
  assert.equal(localDateKey(now), "2026-09-24");

  stats.days["2026-01-01"] = 9;
  stats = recordBlock(stats, now);
  assert.ok(!("2026-01-01" in stats.days));
  assert.equal(stats.total, 3);
});

test("lastDays returns consecutive local dates ending today", () => {
  const days = lastDays(new Date(2026, 2, 1, 9).getTime(), 3).map(d => d.key);
  assert.deepEqual(days, ["2026-02-27", "2026-02-28", "2026-03-01"]);
});

test("appendHistory keeps the newest 100 entries", () => {
  let history = [];
  for (let i = 0; i < 120; i++) history = appendHistory(history, { at: i });
  assert.equal(history.length, 100);
  assert.equal(history[0].at, 20);
});

test("settings normalization rejects bad values", () => {
  const s = normalizeSettings({
    rules: [{ pattern: "https://www.instagram.com/", action: "block" }, { pattern: "??", action: "allow" }],
    llm: { baseUrl: "javascript:alert(1)", model: "  ", timeoutSec: 999, think: false },
    studyHomeUrl: "ftp://x"
  });
  assert.deepEqual(s.rules, [{ pattern: "instagram.com", action: "block" }]);
  assert.equal(s.llm.baseUrl, "http://localhost:11434/v1");
  assert.equal(s.llm.model, "auto");
  assert.equal(s.llm.timeoutSec, 180);
  assert.ok(!("think" in s.llm), "old reasoning options are not persisted");
  assert.equal(s.fastMode, true);
  assert.equal(normalizeSettings({ fastMode: false }).fastMode, false);
  assert.equal(normalizeSettings({ fastMode: "false" }).fastMode, true);
  assert.equal(normalizeSettings({ version: 3, llm: { timeoutSec: 60 } }).llm.timeoutSec, 15);
  assert.equal(normalizeSettings({ version: 4, llm: { timeoutSec: 60 } }).llm.timeoutSec, 60);
  assert.equal(s.studyHomeUrl, "https://leetcode.com/problemset/");
  assert.equal(normalizeLlm({}).enabled, true);
  assert.equal(normalizeLlm({ enabled: false }).enabled, false);
  const remote = normalizeLlm({ baseUrl: "https://me-focusflow-llm.hf.space/v1/", apiKey: "old-secret" });
  assert.equal(remote.baseUrl, "http://localhost:11434/v1");
  assert.equal(remote.apiKey, "");
  assert.equal(remote.enabled, false, "invalid old remote setup must not start a different server silently");
});

test("AI URLs must be loopback endpoints, not remote/spoofed/credentialed addresses", () => {
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1/", "http://[::1]:11434/v1", "https://localhost/v1"]) {
    assert.equal(isLocalAiUrl(url), true, url);
    assert.equal(normalizeLlm({ baseUrl: url }).baseUrl, url.replace(/\/+$/, ""));
  }
  for (const url of ["https://localhost.evil.test/v1", "http://user:pass@localhost/v1", "http://localhost/v1?url=https://evil.test", "http://localhost/v1#x", "http://192.168.0.2/v1", "https://example.com/v1", "http://localhost/api", "javascript:alert(1)"]) {
    assert.equal(isLocalAiUrl(url), false, url);
  }
});
