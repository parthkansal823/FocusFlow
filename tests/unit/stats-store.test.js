import assert from "node:assert/strict";
import { test } from "node:test";
import { appendHistory, countForDay, lastDays, localDateKey, recordBlock } from "../../src/shared/stats.js";
import { normalizeLlm, normalizeSettings } from "../../src/shared/store.js";

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
  assert.ok(!("think" in s.llm), "thinking cannot be switched off");
  assert.equal(s.studyHomeUrl, "https://leetcode.com/problemset/");
  assert.equal(normalizeLlm({ baseUrl: "https://me-focusflow-llm.hf.space/v1/" }).baseUrl, "https://me-focusflow-llm.hf.space/v1");
});
