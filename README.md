# FocusFlow — hard-mode study shield

An Edge/Chromium extension that allows public educational/technical pages while
blocking distractions and detected private content. The interface uses only black, white and grey
and keeps the popup statistics and three-panel blocked screen.

## Hard mode only

There is no normal mode, pause button, always-allow rule or study-bypass screen.

- YouTube Shorts, recommendation home feeds and trending/subscription feeds are
  blocked immediately. Open a lecture link or use a study search instead.
- Instagram/Facebook Reels and Stories, TikTok, and common social home feeds are
  blocked without an AI request. Individual articles/posts on mixed sites are
  still classified, rather than blanket-blocking every domain.
- YouTube recommendations, comments, end-screen suggestions and Shorts links are
  hidden; autoplay is turned off when its control is present.
- Unknown pages are covered and media is paused until a decision arrives. When
  AI is unavailable, the strict offline classifier decides; uncertain content
  stays blocked.
- Old allow rules and study marks do not bypass the hard-mode policy.

An extension cannot prevent its owner from disabling/uninstalling it in the
browser. It is not tamper-proof parental control. Browser/OS restrictions such
as Microsoft Family Safety remain unchanged.

## Fast decisions

1. Privacy guards, hard-block paths and your block rules decide first. There is **no manual
   educational allow-list**. On a site's first allowed visit, local AI checks
   its homepage and the current page together. For new reviews, only an explicit dedicated-study
   verdict backed by homepage metadata grants whole-site trust. It lasts 7 days;
   subsequent pages on that exact host open without scanning, cover screens,
   network lookups or AI calls. A conflicting verdict removes that trust.
   YouTube and uncertain/mixed platforms stay page-by-page. Remembered page
   verdicts are checked before scanning untrusted pages. Older learned sites
   with three agreeing AI study votes are retained; manual allow rules are not.
2. Clear titles on reviewed/mixed sites use a conservative on-device text
   classifier. This requires
   multiple known signals and agreement between the title and other metadata.
   It does not wait for a website lookup or AI call.
3. Ambiguous pages use your local OpenAI-compatible AI server. Qwen reasoning is
   disabled, the response is short JSON, and streamed responses keep the bounded
   request alive across the MV3 idle window.
4. If a request fails or times out, the strict offline model takes over.

The default AI timeout is 15 seconds. Cached pages and obvious local decisions
can be much faster; new ambiguous pages still depend on the model and hardware.
Classification is not perfect: an educational page may be blocked, or misleading
metadata may fool the model. Inspect mistakes with **Settings → Test a page**.

Local AI stays **on by default**. Settings saves local-first decisions; there is
no UI option to force AI for every clear page. Hard mode is always on, even if
you disable the optional AI and use the strict bundled classifier alone.

To reduce background load, startup/model warm-up and speculative hover/visible
link checks are disabled. Only one inference request runs at a time. This avoids
work on pages you never open, but a cold model may make an unclear page slower.
Zero resource use or zero laptop slowdown cannot be guaranteed during inference.

## Run on Microsoft Edge

1. Open `edge://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `D:\Projects\DistractionRemove`, the folder
   containing `manifest.json`. Do not select the ZIP or an old extracted copy.
3. If it is already installed from this folder, click **Reload**, then refresh
   existing website tabs so they receive the new content script.
4. Open FocusFlow → **Settings → Local AI & performance**. Keep AI **On**, and save the local server URL
   `http://localhost:11434/v1`, model `auto`, and the 15-second timeout.
5. Test a lecture URL and a distraction URL using **Test a page**.

Chrome/Brave use their corresponding extensions page and the same folder.

## Local AI (no metered token API)

Keep [Ollama](https://ollama.com/download) running. The extension defaults to the
smaller compatible installed model (Qwen3 preferred). You can explicitly select
another installed model. A smaller model generally needs less memory, but can
be less accurate. The extension does not download a model automatically.

```powershell
ollama pull qwen3:1.7b
```

The existing Windows helper `scripts\windows\setup-ollama.cmd` can install and
configure Ollama. It changes Ollama's user environment settings and downloads a
model; inspect it first if you already have a custom Ollama setup. It now sets
one parallel request and a two-minute idle lifetime instead of keeping the model
loaded forever. These server-wide settings apply only when you run the helper;
editing the extension does not silently restart/reconfigure your Ollama service.

If Ollama is already installed, apply just the idle/concurrency limits and
restart it without installing, downloading or running a model:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-ollama.ps1 -TuneOnly
```

This interrupts current Ollama requests. It keeps the server on, but an idle
model reload will cost time on the next unclear page. Details of these server
settings are in the [Ollama FAQ](https://docs.ollama.com/faq).

If the server returns 403, allow extension origins and restart Ollama:

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'chrome-extension://*', 'User')
```

Local inference does not use a paid token quota, but speed and throughput are
limited by your CPU/GPU and memory. Hosted AI endpoints and known cloud model
tags are rejected. No Hugging Face deployment or paid hosting is needed.
The old `hf-space/` reference folder is not used or included in the extension ZIP.

For store distribution, each user needs their own local Ollama installation for
AI checks; a browser extension cannot bundle and silently start a native server.

## Privacy

- Version 4.0.3 no longer extracts paragraphs, message bodies, editor contents,
  form values, headings or JSON-LD from live pages. It classifies allow-listed
  page titles and head metadata only; arbitrary new metadata fields are discarded.
- A deterministic privacy deny guard protects known personal services,
  account/authentication/mail/chat/payment/private routes, credentialed URLs,
  sensitive query parameters and obvious identifiers. Password/payment/OTP forms,
  editable documents and noindex pages return a protected marker before reading
  metadata. Detected private pages are blocked without AI, training or history;
  only the aggregate block count changes. These are security deny rules, not an
  educational allow-list. They also override saved educational-site trust when
  the URL is sensitive. Work tools/private LMS pages may be blocked deliberately.
- Unclear public page titles, descriptions and sanitized URLs go to the loopback AI
  endpoint only (`localhost`, `127.0.0.1` or `[::1]`). Hosted endpoints are not
  supported, AI requests cannot follow redirects, and API keys are not stored
  or sent. Obvious email addresses, payment-number patterns and credential text
  in metadata cause a privacy block. URLs embedded in text are removed. Query
  strings and fragments are removed from AI URLs (except public YouTube video IDs).
- For richer context, FocusFlow fetches public YouTube watch pages and site home
  pages without browser cookies. Auxiliary requests require HTTPS, reject literal
  IP/intranet hosts and nonstandard ports, do not follow redirects and have bounded
  reads/timeouts. Clear local-first decisions skip these lookups. Website operators
  still receive these ordinary requests and can observe the source IP; this is not
  a fully offline extension or a guarantee against all DNS/private-host aliases.
- Verdict/mark identities are SHA-256 hashes, keeping different searches distinct
  without storing their raw queries. These hashes are NOT encryption or a promise
  of anonymity. Saved verdicts contain no page titles or raw page-text training.
  Block history contains domain-level entries only (no paths, queries or titles),
  capped at 100 entries/7 days; page verdicts expire after 14 days. Expired entries
  are pruned when the extension storage context starts and history is updated.
  Settings, marks, learned site profiles and counts stay in browser-local storage,
  not cloud sync. Direct storage access is restricted to trusted extension contexts;
  content scripts do not have access. There is no analytics/developer collection endpoint.
- Upgrading clears old generated history, raw training, page caches and homepage
  profiles that could retain sensitive text. Safe distraction marks are migrated
  to hashed identities; private marks are discarded. Settings, block rules, counts
  and site-vote evidence remain. Settings offers learning/history reset controls.
- Privacy detection is conservative but heuristic: unusual private applications
  or personal details in supposedly public metadata may not be recognized. Do not
  claim that sensitive data access is impossible, or that local storage is encrypted.
  Malware, other privileged software or someone with device/profile access can
  access browser files or the local AI service. Store disclosures must still cover
  website content and browsing history and match a hosted privacy policy.
- Host permissions are needed to cover/classify websites, fetch public metadata
  for unclear pages and contact the local AI endpoint.

## Development and package

```powershell
npm ci
npm test
npm run lint
npx playwright install chromium
npm run test:e2e
# Test the installed Microsoft Edge instead:
$env:FOCUSFLOW_BROWSER = 'msedge'
npm run test:e2e
npm run package
```

`npm run package` produces `dist/focusflow-4.0.3.zip` containing only the manifest,
icons and extension source. This is a package for submission, not confirmation
of Microsoft store approval. Store listing, screenshots and a public privacy
policy must be supplied separately.

Browser tests use an isolated temporary profile, synthetic websites and a mock
AI server. If a machine's Family Safety blocks a synthetic URL, those specific
tests report a skip; restrictions are not disabled. Unit tests additionally cover
hard-mode precedence, malformed streams, timeouts, stale navigation verdicts and
the local fast path, loopback-only AI, smaller-model selection and single-request
inference. Tests also cover a streamed response longer than 30 seconds.

## License

For personal and educational use.
