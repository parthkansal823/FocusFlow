# FocusFlow: a study-only browser shield

FocusFlow is a Chrome/Edge/Firefox extension for students preparing for SDE placements.
**Only study and tech content opens. Everything else is blocked, and there is no off switch.**

It doesn't rely on a fixed list of "bad sites". Every page is judged from its own
metadata by a **thinking** AI (Qwen3) that you run yourself: on your computer, on your own
free Hugging Face Space, or on a free server. There are no API keys and no daily limits.
A DSA lecture on YouTube opens while a prank video on YouTube is blocked.

## How it decides

```
you open a page
   │
   ├─ your rules / your marks ──────────────────────────────▶ open or block
   ├─ site already proven (3+ pages, all one way) ───────────▶ open or block
   │
   └─ otherwise the page is held (covered, media paused) and judged:
        1. read its metadata   title, description, OpenGraph, JSON-LD, headings
                               YouTube: category, channel, description, tags (fetched from YouTube)
        2. look up the site    its home page, fetched once: what is this website about?
        3. ask the AI          a thinking model (Qwen3, thinking always on) answers
                               ALLOW/BLOCK and whether the site is study / mixed / distraction
        4. remember + learn    verdict cached, offline model trained, site evidence updated
        │
        └─ AI not running? ──▶ offline model (trained from bundled examples + every AI answer)
                               strict: if it isn't sure it's study, it's blocked
```

- **Pages, not domains.** A whole site is only blocked after at least 3 of its pages were
  judged distractions and none were study. One study page makes a site "mixed" for good.
  YouTube is always judged video by video, so study videos are never blocked because other
  videos are.
- **No off switch.** No pause, no break timer, no "disable for 10 minutes", and thinking
  can't be turned off either. If the AI server can't be reached, the offline model keeps blocking.
- **Fast where it matters.** The videos on your screen and the link under your mouse are judged
  in the background *before* you click, so opening them is instant. Every verdict is remembered,
  two requests run in parallel (what you open always goes first), the model is asked to think
  briefly, and the fixed part of the prompt is cached by the server.
- **Mistakes can be corrected, with friction.** On a blocked page judged by the AI you can open
  that one exact page after a 15-second wait and typing *"I am here to study"* (5 per day).
  From the toolbar you can mark any page as a distraction. Both corrections teach the model.

## Setup

### 1. Run the thinking AI (free, unlimited, pick one)

| Where | Speed per new page* | Setup |
| --- | --- | --- |
| **Your computer** (Ollama) | ~2–6 s on a 4 GB+ NVIDIA GPU, ~10–30 s on CPU | one script on Windows, fully offline |
| **Hugging Face Space** | ~10–30 s (2 free CPUs) | upload 2 files, nothing installed |
| **Your own free server** (Oracle Cloud Always Free, 4 CPUs) | ~5–15 s | one `docker run` |

\* Only for pages nobody has judged yet. Videos on screen and hovered links are judged before
you click, and every verdict is remembered, so most clicks are instant.

**Your computer, with [Ollama](https://ollama.com)** (recommended if you have an NVIDIA GPU)

On Windows, double-click **`scripts\windows\setup-ollama.cmd`**. It installs Ollama, tunes it
for speed (model kept loaded, 2 parallel requests, flash attention, compact context memory),
allows the extension, downloads **Qwen3-4B**, checks that it runs on the GPU, and prints a
speed test. Use `setup-ollama.cmd -Model qwen3:1.7b` for faster, lighter answers.

Elsewhere:

```bash
# install from https://ollama.com/download, then:
ollama pull qwen3:4b          # ~2.5 GB thinking model; fits fully in 4 GB of GPU memory
OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" OLLAMA_KEEP_ALIVE=-1 ollama serve
```

The model setting defaults to **auto**, which uses the best thinking model installed on the
server (Qwen3 first, bigger first; coder and embedding models are skipped). Qwen3-4B is the
best choice for a 4 GB GPU: Qwen3-8B judges a little better but no longer fits and runs about
2–3× slower.

**Hugging Face Space or your own server.** See [`hf-space/README.md`](hf-space/README.md).
The same two-file Docker setup (llama.cpp + Qwen3) runs on a free Space or any server.

Any OpenAI-compatible server works: set its `/v1` URL in Settings.

### 2. Load the extension

**Chrome / Edge / Brave**: open `chrome://extensions`, turn on *Developer mode*, click
*Load unpacked* and pick this folder.

**Firefox** (121+): open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*,
pick `manifest.json`, then allow *Access your data for all websites* in the add-on's permissions.

Nothing needs to be edited or copied: there are no secret files and no API keys in the code.

### 3. Check the connection

Open FocusFlow → **Settings** → *Thinking AI*, pick where it runs → **Save**. It should say "✓ Connected".
Use **Test a page** to see exactly what FocusFlow reads from a URL and what the AI decides.

## Using it

| Where | What you get |
| --- | --- |
| Toolbar popup | Current tab's status, **Block this page**, blocks today and a 7-day chart, recent blocks, AI status |
| Blocked page | What was blocked and why, *Back to work*, a YouTube study search, and the "This is study content" correction when allowed |
| Settings | Where the AI runs (computer / HF Space / your server) and which model (auto), **Test a page**, learned sites with their evidence, your own always-allow/always-block rules, your marks, data reset |

## Privacy

- Page metadata goes only to the AI server **you** run (by default `localhost`).
- FocusFlow also fetches public pages without cookies: the YouTube watch page of a video you
  open, and the home page of each new site, to read their metadata.
- Everything else (verdicts, stats, learned sites) stays in the browser's local storage.

## Development

```bash
npm install          # only Playwright, for the end-to-end tests
npm test             # unit tests: rules, decision engine, offline model, LLM client, HTML parsing
npm run test:e2e     # loads the real extension in Chromium against fake sites and a mock LLM
npm run lint         # manifest/file/import checks
npm run package      # dist/focusflow-<version>.zip for the stores
```

The end-to-end tests need Playwright's Chromium (`npx playwright install chromium`).

```text
manifest.json                 MV3, one background module for Chrome (service worker) and Firefox
src/
  background/
    index.js                  event wiring: navigation, storage changes, messages
    controller.js             per-tab state machine, LLM scheduler (priorities, parallel slots), pre-judging
    metadata.js               metadata from the page, YouTube, and site home pages
    html-meta.js              HTML metadata parser (service workers have no DOMParser)
    llm.js                    OpenAI-compatible client, model auto-pick, warm-up, answer parsing
    actions.js                marks (study / distraction), forget site, reset learning
  shared/
    policy.js                 the decision engine + evidence-based site learning (pure, tested)
    offline.js, model.js      on-device Naive Bayes fallback, trained in the browser
    training-data.js          bundled seed examples
    rules.js, stats.js, store.js, defaults.js
  content/guard.js            holds/covers the page while it's judged; reads metadata; reports links to pre-judge
  pages/                      popup, options, blocked page
hf-space/                     Docker setup (llama.cpp + Qwen3) for a free HF Space or your own server
scripts/windows/              one-click Ollama setup + speed test for Windows
tests/unit, tests/e2e
```

### What changed from FocusGuard 3.x

The old version could not run from a fresh clone: `manifest.json` pointed to a `background.js`
that was git-ignored (only a misspelled `backgronud_sample.js` was committed) and a Gemini
API key had to be pasted into the source. When Gemini failed, a bug cached **BLOCK** for every
video for 24 hours, and after in-app navigation YouTube videos were judged by the *previous*
video's title. Version 4 is a rewrite. A single background controller judges every navigation
from its metadata, with a local AI and no fixed lists. It reads YouTube metadata from YouTube
itself, keeps working offline, and is covered by unit and browser tests.

## License

For personal and educational use.
