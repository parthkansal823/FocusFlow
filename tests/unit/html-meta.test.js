import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, parseHtmlMeta, parseYouTubeWatch } from "../../src/background/html-meta.js";

test("parseHtmlMeta reads title, description, OpenGraph, JSON-LD and h1", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Two Sum - LeetCode</title>
    <meta name="description" content="Can you solve this real interview question? Two Sum &amp; more.">
    <meta property="og:site_name" content='LeetCode'>
    <meta property="og:type" content="website">
    <meta name="keywords" content="array, hash table">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":["WebPage","Course"]}</script>
    </head><body><h1 class="x">Two <b>Sum</b></h1></body></html>`;
  const meta = parseHtmlMeta(html);
  assert.equal(meta.title, "Two Sum - LeetCode");
  assert.equal(meta.description, "Can you solve this real interview question? Two Sum & more.");
  assert.equal(meta.siteName, "LeetCode");
  assert.equal(meta.type, "website");
  assert.equal(meta.keywords, "array, hash table");
  assert.equal(meta.jsonLd, "WebPage, Course");
  assert.equal(meta.h1, "Two Sum");
  assert.equal(meta.lang, "en");
});

test("parseHtmlMeta survives junk", () => {
  assert.equal(parseHtmlMeta("").title, "");
  assert.equal(parseHtmlMeta("<html><head><title>x</title>").title, "x");
});

test("parseYouTubeWatch reads category, channel, description and tags", () => {
  const html = `<html><head><title>Binary Search - YouTube</title>
    <meta name="title" content="Binary Search Introduction | Striver">
    <meta name="description" content="Short description">
    <meta name="keywords" content="binary search, dsa, striver">
    </head><body>
    <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc","title":"Binary Search Introduction | Striver",
      "shortDescription":"Full playlist: DSA \\"A2Z\\" course\\nNotes linked","author":"take U forward"},
      "microformat":{"playerMicroformatRenderer":{"category":"Education","ownerChannelName":"take U forward"}}};</script>
    <meta itemprop="genre" content="Education"></body></html>`;
  const meta = parseYouTubeWatch(html);
  assert.equal(meta.title, "Binary Search Introduction | Striver");
  assert.equal(meta.channel, "take U forward");
  assert.equal(meta.category, "Education");
  assert.equal(meta.description, 'Full playlist: DSA "A2Z" course\nNotes linked');
  assert.equal(meta.keywords, "binary search, dsa, striver");
});

test("parseYouTubeWatch falls back to itemprop genre and the page title", () => {
  const html = `<html><head><title>Funny cats - YouTube</title></head><body><meta itemprop="genre" content="Comedy"></body></html>`;
  const meta = parseYouTubeWatch(html);
  assert.equal(meta.title, "Funny cats");
  assert.equal(meta.category, "Comedy");
});

test("decodeEntities", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#39; &#x41; &hellip;"), "a & b 'c' A &hellip;");
});
