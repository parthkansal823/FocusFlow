import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenize } from "../../src/shared/model.js";
import { buildModel, fastVerdict, metadataText, offlineVerdict } from "../../src/shared/offline.js";
import { DISTRACTION_EXAMPLES, STUDY_EXAMPLES } from "../../src/shared/training-data.js";

// Titles that are NOT in the bundled training data.
const HELD_OUT_STUDY = [
  "Longest increasing subsequence | DP on subsequences",
  "Deadlock in operating systems explained with examples",
  "B+ tree insertion and deletion DBMS",
  "Design a notification system | system design interview",
  "Java collections framework ArrayList vs LinkedList",
  "Python decorators and generators tutorial",
  "Rotting oranges BFS leetcode solution",
  "HTTP vs HTTPS and TLS handshake explained",
  "Consistent hashing explained for distributed systems",
  "React context API tutorial for beginners",
  "Binary search on answer | aggressive cows",
  "Detect loop in linked list Floyd cycle detection",
  "Paging and segmentation in operating system",
  "Docker compose tutorial multi container apps",
  "Top 50 SQL interview questions",
  "Microsoft SDE interview experience 2025",
  "Graph coloring backtracking algorithm",
  "Git rebase vs merge explained",
  "Normalization in DBMS hindi",
  "Linked list reversal recursive and iterative in C++"
];

const HELD_OUT_DISTRACTION = [
  "Best comedy scenes of all time",
  "My Europe trip vlog part 2",
  "New Punjabi song official video",
  "India vs Australia highlights world cup",
  "GTA 6 trailer reaction",
  "Minecraft hardcore survival episode 20",
  "Celebrity airport looks gossip",
  "Funny cat videos compilation",
  "Bollywood movie full hd",
  "Top 10 anime fights of the year",
  "Pranking my roommate for a week",
  "BGMI custom room live",
  "Web series review and ending explained",
  "Instagram reels trending dance",
  "IPL auction live updates",
  "Unboxing gaming setup tour",
  "Romantic hindi songs 2025 jukebox",
  "Stand up comedy on marriage",
  "Reaction to viral memes",
  "Movie trailer launch event"
];

test("tokenize keeps words and word pairs, drops stopwords and numbers", () => {
  const tokens = tokenize("The C++ STL tutorial 2025 | Part 1");
  assert.ok(tokens.includes("cplusplus"));
  assert.ok(tokens.includes("stl_tutorial"));
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("2025"));
});

test("bundled data is balanced", () => {
  const ratio = STUDY_EXAMPLES.length / DISTRACTION_EXAMPLES.length;
  assert.ok(ratio > 0.85 && ratio < 1.15, `ratio ${ratio}`);
});

test("offline model classifies unseen titles well (strict: must be sure to allow)", () => {
  const model = buildModel();
  const judge = title => offlineVerdict({ title, host: "youtube.com" }, model).verdict;

  const studyHits = HELD_OUT_STUDY.filter(t => judge(t) === "allow").length;
  const distractionHits = HELD_OUT_DISTRACTION.filter(t => judge(t) === "block").length;
  // Strict mode may block some study titles, but must almost never open a distraction.
  assert.ok(distractionHits >= HELD_OUT_DISTRACTION.length - 1, `distractions blocked: ${distractionHits}/20`);
  assert.ok(studyHits >= 14, `study titles allowed: ${studyHits}/20`);
});

test("unknown content is blocked in strict mode", () => {
  const verdict = offlineVerdict({ title: "zzqx vvbn" }, buildModel());
  assert.equal(verdict.verdict, "block");
  assert.match(verdict.reason, /Could not verify/);
});

test("the offline model learns from corrections and LLM verdicts", () => {
  const title = "Nirvana shatakam chanting for focus";
  const before = offlineVerdict({ title }, buildModel());
  const learned = Array.from({ length: 9 }, () => ({ text: title, label: "study", source: "llm" }));
  const after = offlineVerdict({ title }, buildModel(learned));
  assert.ok(after.pStudy > before.pStudy);
  assert.equal(after.verdict, "allow");
  assert.equal(offlineVerdict({ title }, buildModel([{ text: title, label: "study", source: "user" }])).pStudy, before.pStudy);
});

test("metadataText uses rich metadata", () => {
  const text = metadataText({
    title: "Lecture 3",
    channel: "MIT OpenCourseWare",
    category: "Education",
    description: "In this lecture we cover dynamic programming.",
    host: "youtube.com",
    url: "https://www.youtube.com/watch?v=abcdefghijk"
  });
  assert.match(text, /category Education/);
  assert.match(text, /MIT OpenCourseWare/);
  assert.match(text, /dynamic programming/);
});

test("fast mode answers clear content but defers unknown and conflicting metadata", () => {
  const model = buildModel();
  assert.equal(fastVerdict({ title: "Binary search explained" }, model).verdict, "allow");
  assert.equal(fastVerdict({ title: "Funny cat videos compilation" }, model).verdict, "block");
  assert.equal(fastVerdict({ title: "zzqx vvbn" }, model), null);
  assert.equal(fastVerdict({ title: "Learn more" }, model), null);
  assert.equal(fastVerdict({ description: "Binary search explained" }, model), null);
  assert.equal(fastVerdict({ title: "Funny cat videos compilation", description: "Binary search algorithms programming tutorial data structures leetcode system design operating systems" }, model), null);
});
