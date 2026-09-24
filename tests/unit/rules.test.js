import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentKey, findRule, isLocalHost, normalizeRules, parsePattern, urlWords, youtubeVideoId
} from "../../src/shared/rules.js";

test("parsePattern cleans user input", () => {
  assert.deepEqual(parsePattern("https://www.Reddit.com/r/LeetCode/"), { host: "reddit.com", path: "/r/leetcode" });
  assert.deepEqual(parsePattern("*.twitch.tv"), { host: "twitch.tv", path: "" });
  assert.deepEqual(parsePattern("lms.college.edu?x=1"), { host: "lms.college.edu", path: "" });
  assert.deepEqual(parsePattern("localhost:3000"), { host: "localhost:3000", path: "" });
  assert.equal(parsePattern(""), null);
  assert.equal(parsePattern("not a site"), null);
  assert.equal(parsePattern("nodot"), null);
});

test("findRule: most specific rule wins, subdomains match", () => {
  const rules = normalizeRules([
    { pattern: "reddit.com", action: "block" },
    { pattern: "reddit.com/r/leetcode", action: "allow" },
    { pattern: "example.com", action: "allow" }
  ]);
  assert.equal(findRule(rules, "https://www.reddit.com/r/funny").action, "block");
  assert.equal(findRule(rules, "https://old.reddit.com/r/LeetCode/comments/1").action, "allow");
  assert.equal(findRule(rules, "https://reddit.com/r/leetcodememes").action, "block"); // path boundary
  assert.equal(findRule(rules, "https://notexample.com/"), null); // host boundary
  assert.equal(findRule(rules, "https://a.b.example.com/x").action, "allow");
});

test("normalizeRules drops junk and de-duplicates (last wins)", () => {
  const rules = normalizeRules([
    { pattern: "x.com", action: "block" },
    { pattern: "https://www.x.com/", action: "allow" },
    { pattern: "junk", action: "block" },
    { pattern: "a.com", action: "check" }
  ]);
  assert.deepEqual(rules, [{ pattern: "x.com", action: "allow" }]);
});

test("youtubeVideoId handles watch, live, youtu.be and rejects others", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://m.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
  assert.equal(youtubeVideoId("https://www.youtube.com/live/abcdefghijk"), "abcdefghijk");
  assert.equal(youtubeVideoId("https://youtu.be/abcdefghijk"), "abcdefghijk");
  assert.equal(youtubeVideoId("https://www.youtube.com/results?search_query=dp"), null);
  assert.equal(youtubeVideoId("https://evil.com/watch?v=abcdefghijk"), null);
});

test("contentKey identifies one video or one page", () => {
  assert.equal(contentKey("https://www.youtube.com/watch?v=abcdefghijk&list=x"), "yt:abcdefghijk");
  assert.equal(contentKey("https://WWW.Reddit.com/r/leetcode/#top"), "page:reddit.com/r/leetcode");
  assert.equal(contentKey("https://example.com/"), "page:example.com");
});

test("contentKey keeps meaningful queries and drops tracking noise", () => {
  const dp = contentKey("https://www.google.com/search?q=Dynamic+Programming&utm_source=x&start=10");
  assert.equal(dp, "page:google.com/search?q=dynamic programming");
  assert.notEqual(dp, contentKey("https://www.google.com/search?q=movies"));
  assert.equal(
    contentKey("https://www.youtube.com/results?search_query=dp&si=abc"),
    "page:youtube.com/results?search_query=dp"
  );
  assert.equal(contentKey("https://a.com/p?b=2&a=1"), contentKey("https://a.com/p?a=1&b=2"));
});

test("urlWords turns paths into words", () => {
  assert.equal(urlWords("https://reddit.com/r/leetcode/comments/abc/how_to_learn_dp/"), "r leetcode comments abc how to learn dp");
});

test("isLocalHost", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "[::1]"]) assert.ok(isLocalHost(host), host);
  assert.ok(!isLocalHost("localhost.evil.com"));
});
