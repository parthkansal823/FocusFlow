import assert from "node:assert/strict";
import { test } from "node:test";
import { hardBlockReason } from "../../src/shared/hard-mode.js";
import { decide } from "../../src/shared/policy.js";
import { markStudy } from "../../src/background/actions.js";
import { normalizeSettings } from "../../src/shared/store.js";

test("hard distraction surfaces block immediately, even with legacy bypasses", () => {
  for (const url of [
    "https://www.youtube.com/", "https://m.youtube.com/shorts/abcdefghijk",
    "https://www.youtube.com/s%68orts/abcdefghijk", "https://www.youtube.com./shorts/abcdefghijk",
    "https://youtube.com/@creator/shorts", "https://youtube.com/feed/trending",
    "https://instagram.com/reels/a", "https://www.instagram.com/stories/a",
    "https://facebook.com/watch/", "https://x.com/home", "https://twitter.com/explore",
    "https://reddit.com/r/popular", "https://linkedin.com/feed/", "https://tiktok.com/@study/video/1"
  ]) {
    const ctx = { settings: { rules: [{ pattern: new URL(url).hostname, action: "allow" }], hardMode: false }, overrides: {}, sites: {} };
    assert.equal(decide(url, ctx).reason, "hard", url);
  }
});

test("hard mode does not blanket-block lectures, search, articles or job tools", () => {
  for (const url of [
    "https://youtube.com/watch?v=abcdefghijk", "https://youtube.com/results?search_query=math",
    "https://reddit.com/r/learnprogramming", "https://linkedin.com/jobs/",
    "https://x.com/user/status/1", "https://notyoutube.com/shorts/test", "https://docs.python.org/3/tutorial/"
  ]) assert.equal(hardBlockReason(new URL(url)), "", url);
});

test("there is no normal-mode setting or study-bypass API", async () => {
  const settings = normalizeSettings({ hardMode: false, rules: [{ pattern: "fun.test", action: "allow" }] });
  assert.ok(!("hardMode" in settings));
  assert.deepEqual(settings.rules, []);
  assert.deepEqual(await markStudy({ key: "page:fun.test/", url: "https://fun.test/" }), {
    ok: false, error: "Hard mode is always on. Study bypasses are disabled."
  });
});

test("browser parental-control notices are not replaced or bypassed", () => {
  const ctx = { settings: normalizeSettings({}), overrides: {}, sites: {} };
  assert.equal(decide("https://sdx.microsoft.com/family/restricted-web?url=https://tiktok.com", ctx).reason, "browser-safety");
  assert.equal(decide("https://tiktok.com/", ctx).action, "block");
  assert.equal(decide("https://sdx.microsoft.com/other", ctx).action, "check");
});
