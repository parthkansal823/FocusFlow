// End-to-end: loads the real extension into Chromium and browses fake sites.
// - An HTTPS server plays "www.youtube.com", "blog.test" and "fun.test"
//   (Chromium's host resolver maps those names to it).
// - A mock OpenAI-compatible LLM answers like a thinking model would.
// Run with: npm run test:e2e
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = mkdtempSync(join(tmpdir(), "focusflow-e2e-"));
const llmRequests = [];
const warmUps = [];
let llmDown = false;
let webServer, llmServer, context, extPage, extensionId, llmPort;

// ---------------------------------------------------------------------------
// Fake websites

const page = ({ title, description = "", h1 = "", body = "", head = "" }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${description ? `<meta name="description" content="${description}">` : ""}${head}</head>
<body><main>${h1 ? `<h1>${h1}</h1>` : ""}<p>${description || "Some text that is long enough to be a snippet for the judge."}</p>${body}</main></body></html>`;

const youtubeWatch = ({ title, channel, category, description }) =>
  page({
    title: `${title} - YouTube`,
    head: `<meta name="title" content="${title}"><meta name="description" content="${description}">`,
    body: `<video src="data:," autoplay muted></video><script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { title, author: channel, shortDescription: description },
      microformat: { playerMicroformatRenderer: { category, ownerChannelName: channel } }
    })};</script>`
  });

const SITES = {
  "www.youtube.com": {
    "/": page({ title: "YouTube", description: "Enjoy the videos and music you love." }),
    "/watch?v=studyvid001": youtubeWatch({
      title: "Lecture 19: Dynamic Programming I",
      channel: "MIT OpenCourseWare",
      category: "Education",
      description: "MIT 6.006 Introduction to Algorithms"
    }),
    "/watch?v=funnyvid001": youtubeWatch({
      title: "Try not to laugh challenge #42",
      channel: "LOL Central",
      category: "Comedy",
      description: "The funniest fails of the week"
    }),
    "/watch?v=funnyvid002": youtubeWatch({
      title: "Epic prank on my brother",
      channel: "LOL Central",
      category: "Comedy",
      description: "He did not see it coming"
    }),
    "/watch?v=funnyvid003": youtubeWatch({
      title: "Meme review #100",
      channel: "LOL Central",
      category: "Comedy",
      description: "Best memes of the month"
    }),
    "/results": page({
      title: "graph algorithms - YouTube",
      body: `<a id="v3" href="/watch?v=studyvid003">Dijkstra</a> <a id="v4" href="/watch?v=studyvid004">Topological sort</a>`
    }),
    "/watch?v=studyvid003": youtubeWatch({
      title: "Dijkstra's shortest path algorithm",
      channel: "Abdul Bari",
      category: "Education",
      description: "Graph algorithms lecture"
    }),
    "/watch?v=studyvid004": youtubeWatch({
      title: "Topological sort algorithm",
      channel: "William Fiset",
      category: "Education",
      description: "Graph algorithms lecture"
    }),
    "/watch?v=studyvid002": youtubeWatch({
      title: "Graph algorithms: BFS and DFS",
      channel: "Abdul Bari",
      category: "Education",
      description: "Breadth first search and depth first search algorithms"
    })
  },
  "blog.test": {
    "/": page({ title: "Blog Test", description: "Stories about tech, travel, food and fun." }),
    "/posts/two-pointers": page({
      title: "Two pointers: an algorithms pattern",
      description: "Solve array problems like binary search does, with two pointers.",
      h1: "Two pointers"
    }),
    "/posts/binary-search": page({
      title: "Binary search explained",
      description: "A practical guide to binary search for coding interviews.",
      h1: "Binary search explained"
    }),
    "/posts/links": page({
      title: "Binary search practice list",
      description: "Binary search problems for coding interviews.",
      body: `<a id="next" href="/posts/next-binary-search" style="display:inline-block;padding:20px">Next: binary search on answers</a>`
    }),
    "/posts/next-binary-search": page({
      title: "Binary search on answers",
      description: "Binary search over the answer space, with examples."
    }),
    "/posts/spa": page({
      title: "Binary search explained",
      description: "A practical guide to binary search for coding interviews.",
      body: `<button id="go">Next post</button><script src="/spa.js"></script>`
    }),
    "/spa.js": "document.getElementById('go').onclick = () => { history.pushState({}, '', '/posts/celebrity-gossip'); document.title = 'Celebrity gossip roundup'; };"
  },
  "fun.test": {
    "/": page({ title: "Fun Test", description: "The funniest videos, pranks and memes on the internet." }),
    "/prank": page({ title: "Epic prank compilation", description: "Pranks that went too far." }),
    "/other": page({ title: "More memes", description: "Memes all day." }),
    "/third": page({ title: "Funniest fails", description: "Fails and pranks." }),
    "/fourth": page({ title: "Prank calls", description: "Prank calls compilation." })
  }
};

function serveSite(req, res) {
  const host = (req.headers.host || "").split(":")[0];
  const url = new URL(req.url, `https://${host}`);
  if (url.searchParams.has("slow")) {
    url.searchParams.delete("slow");
    return setTimeout(() => serveSite({ headers: req.headers, url: url.pathname + url.search }, res), 500);
  }
  const video = url.searchParams.get("v");
  const body = (SITES[host] || {})[url.pathname + (video ? `?v=${video}` : "")];
  if (body === undefined) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end(page({ title: "Not found" }));
  }
  res.writeHead(200, { "content-type": req.url.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Mock LLM (OpenAI-compatible, answers with a thinking block first)

function judge(prompt) {
  const website = (prompt.match(/^Website: (.*)$/m) || [])[1] || "";
  const study = /binary search|dynamic programming|Education|algorithms/i.test(prompt) &&
    !/gossip|Comedy|prank|meme/i.test(prompt.split("About the website")[0] + (prompt.match(/(Page|Video) title: .*/) || [""])[0]);
  const site = website === "fun.test" ? "distraction" : "mixed";
  return { verdict: study ? "ALLOW" : "BLOCK", site, reason: study ? "Algorithms study material" : "Entertainment" };
}

function serveLlm(req, res) {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "qwen3:1.7b" }] }));
  }
  let raw = "";
  req.on("data", chunk => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw);
    const prompt = body.messages.at(-1).content;
    if (body.max_tokens === 1) {
      warmUps.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] }));
    }
    llmRequests.push({ body, prompt });
    const answer = judge(prompt);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: `<think>Let me look at the title and category.</think>\n${JSON.stringify(answer)}` }
        }]
      }));
    }, prompt.includes("binary search") ? 900 : 100); // slow enough to see the cover
  });
}

// ---------------------------------------------------------------------------

const listen = server => new Promise(done => server.listen(0, "127.0.0.1", () => done(server.address().port)));

// Extension APIs are reached through one of our own pages (Playwright's worker
// evaluate doesn't expose them).
async function setLlm(patch) {
  await extPage.evaluate(async patch => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, llm: { ...(settings.llm || {}), ...patch } } });
  }, patch);
}

// A navigation the extension blocks before it commits is reported as aborted.
async function visit(tab, url) {
  try {
    await tab.goto(url);
  } catch (error) {
    if (!/ERR_ABORTED/.test(error.message)) throw error;
  }
}

// Wait until `tab` shows the blocked page *for this url* (it may already show another one).
async function waitForBlocked(tab, url, timeout = 15000) {
  const needle = `url=${encodeURIComponent(url)}&`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (tab.url().includes("blocked.html") && tab.url().includes(needle)) {
      await tab.waitForFunction(() => document.querySelector("#reason")?.textContent, null, { timeout: 5000 });
      return;
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`${url} was not blocked (tab is at ${tab.url()})`);
}

const storage = key => extPage.evaluate(async key => (await chrome.storage.local.get(key))[key], key);

before(async () => {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=focusflow-test",
    "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem")
  ], { stdio: "ignore" });
  webServer = https.createServer({ key: readFileSync(join(tmp, "key.pem")), cert: readFileSync(join(tmp, "cert.pem")) }, serveSite);
  const webPort = await listen(webServer);
  llmServer = http.createServer((req, res) => (llmDown ? req.socket.destroy() : serveLlm(req, res)));
  llmPort = await listen(llmServer);

  context = await chromium.launchPersistentContext(join(tmp, "profile"), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${webPort}, MAP *.test 127.0.0.1:${webPort}`,
      "--ignore-certificate-errors",
      "--no-proxy-server" // the fake sites live on this machine
    ]
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extensionId = new URL(sw.url()).host;
  extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/src/pages/popup/popup.html`);
  await setLlm({ baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: "auto", timeoutSec: 20 });
});

after(async () => {
  await context?.close();
  webServer?.close();
  llmServer?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("the extension loads with strict defaults and no fixed lists", async () => {
  const settings = await storage("settings");
  assert.equal(settings.version, 3);
  assert.deepEqual(settings.rules, []);
  assert.ok(!("think" in settings.llm), "no way to switch thinking off");
});

test("a study page on a mixed site opens after the local AI judges its metadata", async () => {
  const tab = await context.newPage();
  const before = llmRequests.length;
  await tab.goto("https://blog.test/posts/binary-search");
  // While the (slow) thinking model works, the page is covered.
  await tab.waitForSelector("focusflow-cover", { state: "attached", timeout: 5000 });
  await tab.waitForSelector("focusflow-cover", { state: "detached", timeout: 15000 });
  assert.equal(tab.url(), "https://blog.test/posts/binary-search");

  const request = llmRequests.slice(before).find(r => r.prompt.includes("Binary search explained"));
  assert.ok(request, "LLM was asked about the page");
  assert.match(request.prompt, /Description: A practical guide to binary search/);
  assert.match(request.prompt, /About the website \(its home page\): Blog Test — Stories about tech/);
  assert.match(request.prompt, /\/think$/);
  assert.equal(request.body.model, "qwen3:1.7b", "model 'auto' picked the installed Qwen3");
  assert.ok(warmUps.some(w => w.model === "qwen3:1.7b"), "the model was warmed up when the server was set");

  // One judged page is evidence, not a verdict on the whole site.
  const sites = await storage("sites");
  assert.equal(sites["blog.test"].allowed, 1);
  assert.equal(sites["blog.test"].votes.mixed, 1);
  await tab.close();
});

test("distractions are blocked page by page; a whole site only after 3 agree", async () => {
  const tab = await context.newPage();
  await visit(tab, "https://fun.test/prank");
  await waitForBlocked(tab, "https://fun.test/prank");
  assert.match(await tab.textContent("#what"), /Epic prank compilation/);
  assert.equal(await tab.textContent("#sourceChip"), "Thinking AI");
  assert.equal(await tab.isVisible("#appeal"), true, "AI verdicts can be appealed");

  // One or two blocked pages are not enough to block the whole site.
  for (const path of ["/other", "/third"]) {
    const before = llmRequests.length;
    await visit(tab, `https://fun.test${path}`);
    await waitForBlocked(tab, `https://fun.test${path}`);
    assert.equal(llmRequests.length, before + 1, `${path} was judged on its own`);
  }

  // Three pages, all distractions, AI says it's a distraction site: now the site is learned.
  const before = llmRequests.length;
  await visit(tab, "https://fun.test/fourth");
  await waitForBlocked(tab, "https://fun.test/fourth");
  assert.equal(llmRequests.length, before);
  assert.match(await tab.textContent("#reason"), /learned that fun\.test is a distraction site \(3 pages blocked, none were study\)/);
  assert.equal(await tab.isVisible("#appeal"), false, "learned distraction sites cannot be appealed");
  await tab.close();
});

test("YouTube videos are judged from YouTube's own metadata (category, channel)", async () => {
  const tab = await context.newPage();
  await tab.goto("https://www.youtube.com/watch?v=studyvid001");
  await tab.waitForTimeout(2500);
  assert.match(tab.url(), /watch\?v=studyvid001/);
  const study = llmRequests.find(r => r.prompt.includes("Lecture 19"));
  assert.match(study.prompt, /YouTube category: Education/);
  assert.match(study.prompt, /Channel: MIT OpenCourseWare/);

  await visit(tab, "https://www.youtube.com/watch?v=funnyvid001");
  await waitForBlocked(tab, "https://www.youtube.com/watch?v=funnyvid001");
  const funny = llmRequests.find(r => r.prompt.includes("Try not to laugh"));
  assert.match(funny.prompt, /YouTube category: Comedy/);
  assert.equal(await tab.isVisible("#ytSearch"), true, "offers a study search instead");

  // Remembered: going back to the study video needs no new LLM call.
  const before = llmRequests.length;
  await tab.goto("https://www.youtube.com/watch?v=studyvid001");
  await tab.waitForTimeout(1000);
  assert.match(tab.url(), /studyvid001/);
  assert.equal(llmRequests.length, before);

  // More distracting videos never turn into a whole-YouTube block…
  for (const id of ["funnyvid002", "funnyvid003"]) {
    await visit(tab, `https://www.youtube.com/watch?v=${id}`);
    await waitForBlocked(tab, `https://www.youtube.com/watch?v=${id}`);
  }
  // …so a new lecture still opens.
  await visit(tab, "https://www.youtube.com/watch?v=studyvid002");
  await tab.waitForTimeout(2500);
  assert.match(tab.url(), /watch\?v=studyvid002/);
  assert.ok(llmRequests.some(r => r.prompt.includes("Graph algorithms: BFS and DFS")));
  await tab.close();
});

test("in-page (SPA) navigation is judged too", async () => {
  const tab = await context.newPage();
  await tab.goto("https://blog.test/posts/spa");
  await tab.waitForTimeout(2500);
  assert.match(tab.url(), /posts\/spa$/);
  await tab.click("#go");
  await waitForBlocked(tab, "https://blog.test/posts/celebrity-gossip");
  assert.match(await tab.textContent("#what"), /Celebrity gossip/);

  // blog.test has study and non-study pages: it stays page-by-page.
  await visit(tab, "https://blog.test/posts/two-pointers");
  await tab.waitForTimeout(2500);
  assert.match(tab.url(), /two-pointers$/);
  await tab.close();
});

test("a settings change during a slow check still judges the real page", async () => {
  const tab = await context.newPage();
  const before = llmRequests.length;
  // A rule is added just as a slow page starts loading: every open tab is re-checked
  // while this page's first check is still waiting for its metadata.
  await extPage.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, rules: [{ pattern: "unrelated.example", action: "block" }] } });
  });
  await tab.goto("https://blog.test/posts/binary-search?edition=2&slow=1");
  await tab.waitForTimeout(3000);
  assert.equal(tab.url(), "https://blog.test/posts/binary-search?edition=2&slow=1");
  const asked = llmRequests.slice(before).filter(r => r.prompt.includes("edition=2"));
  assert.ok(asked.length >= 1);
  assert.ok(asked.every(r => /Page title: Binary search explained/.test(r.prompt)), "never asked without the page's metadata");
  await extPage.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, rules: [] } });
  });
  await tab.close();
});

test("videos on screen are judged before you click them", async () => {
  const tab = await context.newPage();
  await tab.goto("https://www.youtube.com/results?search_query=graph+algorithms");
  // The two result videos get judged in the background while you look at the list.
  const deadline = Date.now() + 15000;
  const judged = () => ["Dijkstra's shortest path", "Topological sort algorithm"]
    .every(title => llmRequests.some(r => r.prompt.includes(title)));
  while (!judged() && Date.now() < deadline) await tab.waitForTimeout(100);
  assert.ok(judged(), "visible videos were pre-judged");

  // Clicking is now instant: no new AI request, no cover.
  const before = llmRequests.length;
  await tab.click("#v3");
  await tab.waitForURL(/studyvid003/);
  await tab.waitForTimeout(800);
  assert.match(tab.url(), /watch\?v=studyvid003/);
  assert.equal(llmRequests.length, before);
  assert.equal(await tab.locator("focusflow-cover").count(), 0);
  await tab.close();
});

test("the link under the mouse is judged before the click", async () => {
  const tab = await context.newPage();
  await tab.goto("https://blog.test/posts/links");
  await tab.waitForTimeout(2500); // the page itself gets judged first
  await tab.hover("#next");
  const deadline = Date.now() + 15000;
  const judged = () => llmRequests.some(r => r.prompt.includes("Binary search on answers"));
  while (!judged() && Date.now() < deadline) await tab.waitForTimeout(100);
  assert.ok(judged(), "hovered link was pre-judged");

  const before = llmRequests.length;
  await tab.click("#next");
  await tab.waitForURL(/next-binary-search/);
  await tab.waitForTimeout(800);
  assert.equal(llmRequests.length, before);
  await tab.close();
});

test("when the LLM is down, the offline model takes over and stays strict", async () => {
  llmDown = true;
  const tab = await context.newPage();
  await tab.goto("https://blog.test/posts/binary-search?fresh=1"); // new key: not cached
  await tab.waitForTimeout(2500);
  // Cached per page path, so the study post is still allowed without the LLM.
  assert.match(tab.url(), /binary-search/);

  await setLlm({ model: "other-model" }); // new model => cached verdicts no longer apply
  await visit(tab, "https://blog.test/");
  await waitForBlocked(tab, "https://blog.test/");
  assert.equal(await tab.textContent("#sourceChip"), "Offline model");
  assert.match(await tab.textContent("#reason"), /LLM unavailable/);
  const status = await storage("llmStatus");
  assert.equal(status.ok, false);
  llmDown = false;
  await setLlm({ model: "auto" });
  await tab.close();
});

test("the popup and settings pages render the learned state", async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/pages/popup/popup.html`);
  await popup.waitForFunction(() => Number(document.querySelector("#todayCount").textContent) > 0);
  assert.ok(Number(await popup.textContent("#todayCount")) >= 4);
  assert.match(await popup.textContent("#learned"), /Learned \d+ sites?/);
  assert.equal(await popup.locator("#recentList li").count(), 4);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/pages/options/options.html`);
  await options.waitForSelector("#siteList li");
  const sites = await options.locator("#siteList li .item-title").allTextContents();
  assert.ok(sites.includes("fun.test") && sites.includes("blog.test"), sites.join(","));

  // "Test a page" shows metadata and both verdicts without learning anything.
  await options.fill("#testUrl", "https://www.youtube.com/watch?v=funnyvid001");
  await options.click("#testForm button[type=submit]");
  await options.waitForSelector(".verdicts", { timeout: 15000 });
  const cards = await options.locator(".verdict-value").allTextContents();
  assert.deepEqual(cards, ["Blocked", "Blocked"]);
  assert.match(await options.textContent(".meta-table"), /Comedy/);
  await popup.close();
  await options.close();
});

test("'This is study content' needs a wait and the exact sentence, then opens the page", async () => {
  const tab = await context.newPage();
  await visit(tab, "https://fun.test/"); // learned distraction site: no appeal possible
  await waitForBlocked(tab, "https://fun.test/");
  assert.equal(await tab.isVisible("#appeal"), false);

  await visit(tab, "https://blog.test/posts/nope"); // 404 page on a mixed site -> AI blocks it
  await waitForBlocked(tab, "https://blog.test/posts/nope");
  await tab.click("#appeal summary");
  assert.equal(await tab.isDisabled("#appealSubmit"), true);
  await tab.waitForFunction(() => !document.querySelector("#appealSubmit").disabled, null, { timeout: 20000 });
  await tab.fill("#appealInput", "let me in");
  await tab.click("#appealSubmit");
  assert.match(await tab.textContent("#appealError"), /exactly/);
  await tab.fill("#appealInput", "I am here to study");
  await tab.click("#appealSubmit");
  await tab.waitForURL("https://blog.test/posts/nope", { timeout: 10000 });
  await tab.waitForTimeout(1000);
  assert.equal(tab.url(), "https://blog.test/posts/nope");
  const overrides = await storage("overrides");
  assert.equal(overrides["page:blog.test/posts/nope"].verdict, "allow");
  await tab.close();
});
