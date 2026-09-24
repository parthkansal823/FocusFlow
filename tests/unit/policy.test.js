import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, forgetSiteRecord, recordSitePage, siteType, studyMarksToday } from "../../src/shared/policy.js";
import { normalizeSettings } from "../../src/shared/store.js";

const ctx = (patch = {}) => ({
  settings: normalizeSettings({ rules: patch.rules || [] }),
  overrides: patch.overrides || {},
  sites: patch.sites || {}
});

test("strict by default: any unknown website is checked", () => {
  const d = decide("https://www.instagram.com/reels/abc", ctx());
  assert.deepEqual(d, { action: "check", key: "page:instagram.com/reels/abc", kind: "page", host: "instagram.com" });
  assert.equal(decide("https://www.youtube.com/watch?v=abcdefghijk", ctx()).kind, "youtube");
});

test("browser pages and your own dev servers are never checked", () => {
  assert.equal(decide("chrome://extensions", ctx()).action, "allow");
  assert.equal(decide("about:blank", ctx()).action, "allow");
  assert.equal(decide("http://localhost:5173/", ctx()).reason, "local");
});

test("there are no built-in site lists", () => {
  for (const url of ["https://netflix.com", "https://leetcode.com/problems/two-sum", "https://github.com"]) {
    assert.equal(decide(url, ctx()).action, "check", url);
  }
});

const evidence = (verdict, vote, n) => {
  let record;
  for (let i = 0; i < n; i++) record = recordSitePage(record, { verdict, vote }, i);
  return record;
};

test("a whole site is only opened or blocked on evidence", () => {
  const sites = {
    "leetcode.com": evidence("allow", "study", 3),
    "netflix.com": evidence("block", "distraction", 3),
    "reddit.com": evidence("block", "mixed", 5),
    "new.com": evidence("block", "distraction", 2)
  };
  assert.deepEqual(decide("https://leetcode.com/problems/x", ctx({ sites })), { action: "allow", reason: "site" });
  assert.equal(decide("https://www.netflix.com/browse", ctx({ sites })).reason, "site");
  assert.equal(decide("https://www.netflix.com/browse", ctx({ sites })).action, "block");
  assert.equal(decide("https://reddit.com/r/funny", ctx({ sites })).action, "check"); // the AI says mixed
  assert.equal(decide("https://new.com/a", ctx({ sites })).action, "check"); // not enough pages yet
  // A fetched home-page profile alone changes nothing.
  assert.equal(decide("https://x.com/", ctx({ sites: { "x.com": { profile: {} } } })).action, "check");
});

test("one study page keeps a site from ever being blocked as a whole", () => {
  let record = evidence("block", "distraction", 10);
  assert.equal(siteType(record), "distraction");
  record = recordSitePage(record, { verdict: "allow" }, 99); // e.g. you marked one page as study
  assert.equal(siteType(record), "mixed");
  record = recordSitePage(record, { verdict: "block", vote: "distraction" }, 100);
  assert.equal(siteType(record), "mixed");
  assert.equal(decide("https://site.com/next", ctx({ sites: { "site.com": record } })).action, "check");
});

test("forgetting a site keeps its profile but drops the evidence", () => {
  const record = { ...evidence("block", "distraction", 4), profile: { title: "Site" } };
  assert.deepEqual(forgetSiteRecord(record), { profile: { title: "Site" } });
  assert.equal(siteType(forgetSiteRecord(record)), "");
});

test("YouTube is always judged per video, never as a whole site", () => {
  const sites = { "youtube.com": evidence("block", "distraction", 50) };
  assert.equal(decide("https://www.youtube.com/watch?v=abcdefghijk", ctx({ sites })).action, "check");
  assert.equal(decide("https://www.youtube.com/results?search_query=dp", ctx({ sites })).action, "check");
  assert.equal(decide("https://m.youtube.com/", ctx({ sites })).action, "check");
});

test("precedence: distraction mark > your rules > study mark > learned site", () => {
  const url = "https://reddit.com/r/leetcode";
  const key = "page:reddit.com/r/leetcode";
  const allowRule = [{ pattern: "reddit.com", action: "allow" }];
  const blockRule = [{ pattern: "reddit.com", action: "block" }];

  assert.equal(decide(url, ctx({ rules: allowRule, overrides: { [key]: { verdict: "block" } } })).reason, "marked");
  assert.equal(decide(url, ctx({ rules: blockRule, overrides: { [key]: { verdict: "allow" } } })).action, "block");
  const distractionSite = { "reddit.com": evidence("block", "distraction", 3) };
  assert.equal(decide(url, ctx({ overrides: { [key]: { verdict: "allow" } }, sites: distractionSite })).action, "allow");
  assert.equal(decide(url, ctx({ rules: allowRule, sites: distractionSite })).action, "allow");
});

test("studyMarksToday counts only today's study marks", () => {
  const now = new Date(2026, 8, 24, 15).getTime();
  const yesterday = new Date(2026, 8, 23, 23).getTime();
  const overrides = {
    a: { verdict: "allow", at: now - 1000 },
    b: { verdict: "allow", at: yesterday },
    c: { verdict: "block", at: now }
  };
  assert.equal(studyMarksToday(overrides, now), 1);
});
