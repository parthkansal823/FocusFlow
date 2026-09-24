// Metadata parsing for HTML fetched from the network. Service workers have no
// DOMParser, so this is careful regex work. Pure functions, unit tested.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

export function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code) => {
    const lower = code.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower];
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return match;
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim() : "";
}

function metaTags(head) {
  const out = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase();
    const content = attr(tag, "content");
    if (key && content && !(key in out)) out[key] = content;
  }
  return out;
}

function jsonLdTypes(html) {
  const types = new Set();
  for (const block of html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    for (const m of block.matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)) {
      try {
        [].concat(JSON.parse(m[1])).forEach(t => typeof t === "string" && types.add(t));
      } catch {
        // ignore broken JSON-LD
      }
    }
  }
  return [...types].slice(0, 5).join(", ");
}

function firstTagText(html, tag) {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

/** Generic page metadata from raw HTML. */
export function parseHtmlMeta(html) {
  const text = String(html || "");
  const headEnd = text.search(/<\/head>/i);
  const head = headEnd > 0 ? text.slice(0, headEnd) : text.slice(0, 200_000);
  const meta = metaTags(head);
  return {
    title: firstTagText(head, "title") || meta["og:title"] || "",
    description: meta.description || meta["og:description"] || meta["twitter:description"] || "",
    siteName: meta["og:site_name"] || meta["application-name"] || "",
    type: meta["og:type"] || "",
    keywords: meta.keywords || "",
    h1: firstTagText(text, "h1").slice(0, 200),
    jsonLd: jsonLdTypes(text),
    lang: attr((text.match(/<html\b[^>]*>/i) || [""])[0], "lang")
  };
}

function jsonString(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return "";
  }
}

// The JSON object that follows `"key":` (roughly — enough to search inside it).
function segmentAfter(text, key, length = 30_000) {
  const i = text.indexOf(`"${key}":`);
  return i === -1 ? "" : text.slice(i, i + length);
}

/** Metadata of a YouTube watch page: title, channel, category, description, tags. */
export function parseYouTubeWatch(html) {
  const text = String(html || "");
  const meta = metaTags(text.slice(0, 600_000)); // itemprop tags live in the body
  const details = segmentAfter(text, "videoDetails");
  const microformat = segmentAfter(text, "playerMicroformatRenderer");
  const pageTitle = firstTagText(text.slice(0, 200_000), "title").replace(/\s*-\s*YouTube$/i, "");
  return {
    title: meta.title || meta["og:title"] || jsonString(details, "title") || pageTitle,
    channel: jsonString(details, "author") || jsonString(microformat, "ownerChannelName") || "",
    category: jsonString(microformat, "category") || meta.genre || "",
    description: jsonString(details, "shortDescription") || meta.description || meta["og:description"] || "",
    keywords: meta.keywords || "",
    siteName: "YouTube",
    type: "video"
  };
}
