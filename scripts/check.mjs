// Static checks with no dependencies: every file the manifest and pages point
// to exists, and every relative import resolves to a real export.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = message => errors.push(message);

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// 1. Manifest references
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const referenced = [
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.action.default_popup,
  manifest.options_ui.page,
  manifest.background.service_worker,
  ...(manifest.background.scripts || []),
  ...manifest.content_scripts.flatMap(c => c.js)
];
for (const file of referenced) {
  if (!existsSync(join(root, file))) fail(`manifest.json: missing ${file}`);
}

// 2. HTML references
const files = walk(join(root, "src"));
for (const html of files.filter(f => f.endsWith(".html"))) {
  const text = readFileSync(html, "utf8");
  for (const [, ref] of text.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!existsSync(resolve(dirname(html), ref))) fail(`${relative(root, html)}: missing ${ref}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) fail(`${relative(root, html)}: inline <script> is blocked by the extension CSP`);
}

// 3. Imports resolve to real exports
function exportsOf(file) {
  const text = readFileSync(file, "utf8");
  const names = new Set();
  for (const [, name] of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(name);
  }
  for (const [, list] of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    list.split(",").forEach(part => names.add(part.trim().split(/\s+as\s+/).pop()));
  }
  return names;
}

for (const file of files.filter(f => f.endsWith(".js"))) {
  const text = readFileSync(file, "utf8");
  for (const [, clause, spec] of text.matchAll(/import\s+([\s\S]*?)\s+from\s+"([^"]+)"/g)) {
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      fail(`${relative(root, file)}: cannot resolve ${spec}`);
      continue;
    }
    const named = clause.match(/\{([^}]*)\}/);
    if (!named) continue;
    const available = exportsOf(target);
    for (const part of named[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name && !available.has(name)) fail(`${relative(root, file)}: "${name}" is not exported by ${spec}`);
    }
  }
}

// 4. The content script must be a classic script (no import/export).
for (const script of manifest.content_scripts.flatMap(c => c.js)) {
  if (/^\s*(import|export)\s/m.test(readFileSync(join(root, script), "utf8"))) {
    fail(`${script}: content scripts cannot use import/export`);
  }
}

if (errors.length) {
  console.error(errors.map(e => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`✓ manifest, ${files.length} source files and all imports check out`);
