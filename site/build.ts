// Builds inyon.abhashchakraborty.tech: the home page, the download page, the docs (site/docs/*.md)
// and the changelog (from GitHub releases). Static files only; GitHub Pages serves them.
//
//   bun site/build.ts                 build into site/out, release details read from GitHub
//   bun site/build.ts --mirror        also download the latest release's files into /download,
//                                     each checked against its SHA256SUMS (the Pages workflow)
//   bun site/build.ts --offline       skip GitHub entirely (no download table, no changelog)
import { createHash, createPublicKey, verify } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);
const SITE = import.meta.dir;
const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(SITE, "out");
const MIRROR = args.includes("--mirror");
const OFFLINE = args.includes("--offline");
const REPO = "Abhash-Chakraborty/inyon";
const ORIGIN = "https://inyon.abhashchakraborty.tech";
const GITHUB = `https://github.com/${REPO}`;

// The sidebar, in reading order. Every page in site/docs must be listed here (checked below).
const NAV: { title: string; pages: string[] }[] = [
  { title: "Start here", pages: ["index", "quick-start", "setups", "install"] },
  { title: "Using Inyon", pages: ["overview", "sessions", "controls", "terminal", "notifications", "settings"] },
  { title: "Phone", pages: ["android", "browser-copy"] },
  { title: "Machines and hubs", pages: ["computers", "hub", "machines"] },
  { title: "Reference", pages: ["cli", "configuration", "agents", "security", "troubleshooting", "changelog"] },
];

interface Page {
  slug: string;
  title: string;
  description: string;
  html: string;
  toc: { id: string; text: string; level: number }[];
  source?: string;
}

interface Asset {
  name: string;
  size: number;
  sha256?: string;
}

interface Release {
  version: string;
  tag: string;
  date: string;
  assets: Asset[];
}

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`'’"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const url = (slug: string) => (slug === "index" ? "/docs/" : `/docs/${slug}/`);
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function frontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

/** Markdown to the site's HTML: heading anchors, a table of contents, copyable code, callouts,
 *  links between pages and images from the repo's docs/ folder. */
function render(md: string): { html: string; toc: Page["toc"] } {
  let html = Bun.markdown.html(md);
  const toc: Page["toc"] = [];
  const seen = new Map<string, number>();

  html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
    const text = strip(inner);
    let id = slugify(text);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    toc.push({ id, text, level: Number(level) });
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${level}>`;
  });

  html = html.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table"><table>$1</table></div>');

  html = html.replace(
    /<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_, lang: string | undefined, code: string) => {
      const label = lang ? `<span class="lang">${lang === "sh" ? "shell" : lang}</span>` : "";
      // shell comments read as notes, not commands
      const body =
        lang === "sh" || lang === "powershell"
          ? code.replace(/(^|\s)(#[^\n]*)/g, '$1<span class="c">$2</span>')
          : code;
      return `<div class="code">${label}<button class="copy" type="button" aria-label="Copy">Copy</button><pre><code>${body}</code></pre></div>`;
    },
  );

  // > **Note:** … / **Warning:** … / **Tip:** … become callouts
  html = html.replace(
    /<blockquote>\s*<p><strong>(Note|Warning|Tip)[:.]?<\/strong>:?\s*([\s\S]*?)<\/blockquote>/g,
    (_, kind: string, rest: string) =>
      `<aside class="callout ${kind.toLowerCase()}"><span class="callout-label">${kind}</span><p>${rest}</aside>`,
  );

  // links between docs pages: quick-start.md#x → /docs/quick-start/#x
  html = html.replace(/href="([\w-]+)\.md(#[\w-]*)?"/g, (_, slug: string, hash = "") => `href="${url(slug)}${hash}"`);
  html = html.replace(/href="\.\.\/\.\.\/(SECURITY|CONTRIBUTING|LICENSE|NOTICE)(\.md)?"/g, `href="${GITHUB}/blob/main/$1$2"`);
  // images from the repo's docs/ folder are copied to /img; a -light image with a -dark twin
  // follows the reader's colour scheme
  html = html.replace(/<img src="\.\.\/\.\.\/docs\/([\w.-]+)"([^>]*)>/g, (_, file: string, rest: string) => {
    const img = `<img src="/img/${file}"${rest.replace(/\s*\/$/, "")} loading="lazy" decoding="async">`;
    const dark = file.replace("-light.", "-dark.");
    return dark !== file && existsSync(join(ROOT, "docs", dark))
      ? `<picture><source media="(prefers-color-scheme: dark)" srcset="/img/${dark}">${img}</picture>`
      : img;
  });
  // external links say so
  html = html.replace(/<a href="(https?:\/\/[^"]+)">/g, (m, href: string) =>
    href.startsWith(ORIGIN) ? m : `<a href="${href}" class="ext" rel="noopener">`,
  );
  return { html, toc };
}

// ---------- GitHub ----------

async function gh(path: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "inyon-site" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers });
  if (!r.ok) throw new Error(`GitHub ${path}: ${r.status}`);
  return r.json();
}

interface GhRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: { name: string; size: number; browser_download_url: string }[];
}

// Files the site serves from /download. The old tether-node copies stay on GitHub only.
const mirrored = (name: string) => !name.startsWith("tether-node");

async function latestRelease(): Promise<{ release: Release; raw: GhRelease } | null> {
  if (OFFLINE) return null;
  const raw = (await gh("/releases/latest")) as GhRelease;
  const assets = raw.assets.filter((a) => mirrored(a.name)).map((a) => ({ name: a.name, size: a.size }));
  return {
    raw,
    release: {
      version: raw.tag_name.replace(/^v/, ""),
      tag: raw.tag_name,
      date: raw.published_at.slice(0, 10),
      assets,
    },
  };
}

/** Inyon's release key (minisign key 0F27F489FF0BBD53), the same one apps/cli/src/signing.rs carries. */
export const RELEASE_KEY = "RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6";

/**
 * Whether `sig` (a .minisig file) signs `data` with `key` (a minisign public key's base64 line).
 * Only the hashed kind ("ED": Ed25519 over the file's BLAKE2b-512) is accepted, as in the CLI, and
 * the trusted comment's own signature has to check out too.
 */
export function minisignOk(data: Buffer, sig: string, key: string): boolean {
  const pk = Buffer.from(key.trim(), "base64");
  const lines = sig.split("\n").map((l) => l.trim());
  if (pk.length !== 42 || pk.subarray(0, 2).toString() !== "Ed" || lines.length < 4) return false;
  const s = Buffer.from(lines[1], "base64");
  const comment = lines[2].match(/^trusted comment: (.*)$/)?.[1];
  const global = Buffer.from(lines[3], "base64");
  if (s.length !== 74 || s.subarray(0, 2).toString() !== "ED" || comment === undefined || global.length !== 64) return false;
  if (!s.subarray(2, 10).equals(pk.subarray(2, 10))) return false;
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.subarray(10).toString("base64url") }, format: "jwk" });
  const digest = createHash("blake2b512").update(data).digest();
  const sigBytes = s.subarray(10);
  return (
    verify(null, digest, pub, sigBytes) && verify(null, Buffer.concat([sigBytes, Buffer.from(comment)]), pub, global)
  );
}

/** Downloads every mirrored file of the release and refuses to publish one that doesn't match the
 *  release's SHA256SUMS, so the domain can never serve something the release didn't sign off. */
async function mirror(release: Release, raw: GhRelease) {
  const dir = join(OUT, "download");
  mkdirSync(dir, { recursive: true });
  const fetchAsset = async (name: string) => {
    const a = raw.assets.find((x) => x.name === name);
    if (!a) throw new Error(`release has no ${name}`);
    const r = await fetch(a.browser_download_url, { redirect: "follow" });
    if (!r.ok) throw new Error(`download ${name}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const sumsBytes = await fetchAsset("SHA256SUMS");
  const sums = sumsBytes.toString("utf8");
  // from 0.14 the list is signed, and inyon update refuses a copy without its signature, so the
  // site publishes nothing unless the list carries a good one
  const signed = raw.assets.some((a) => a.name === "SHA256SUMS.minisig");
  if (signed) {
    if (!minisignOk(sumsBytes, (await fetchAsset("SHA256SUMS.minisig")).toString("utf8"), RELEASE_KEY)) {
      throw new Error("SHA256SUMS isn't signed by the release key");
    }
    console.log("  SHA256SUMS signature checked");
  } else if (!/^0\.(\d|1[0-3])\./.test(release.version)) {
    throw new Error(`${release.tag} has no SHA256SUMS.minisig`);
  }
  const expected = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m) expected.set(m[2], m[1]);
  }
  for (const asset of release.assets) {
    const data = asset.name === "SHA256SUMS" ? sumsBytes : await fetchAsset(asset.name);
    const sha = createHash("sha256").update(data).digest("hex");
    const want = expected.get(asset.name);
    // the sums can't list themselves or their signature, and the installers are what check them,
    // so those come straight from the release; any other unlisted file stops the build
    if (want && want !== sha) throw new Error(`${asset.name}: checksum mismatch`);
    if (!want && !/^(SHA256SUMS|get\.sh$|get\.ps1$)/.test(asset.name)) {
      throw new Error(`${asset.name}: not in SHA256SUMS`);
    }
    asset.sha256 = sha;
    writeFileSync(join(dir, asset.name), data);
    // the installers are also served short, at the site's root
    if (asset.name === "get.sh" || asset.name === "get.ps1") writeFileSync(join(OUT, asset.name), data);
    // a stable name for the newest APK
    if (asset.name.endsWith(".apk")) writeFileSync(join(dir, "inyon.apk"), data);
    console.log(`  ${asset.name} ${mb(asset.size)} ${want ? "checked" : ""}`);
  }
}

async function changelog(): Promise<string> {
  if (OFFLINE) return `<p>The release notes are on <a class="ext" href="${GITHUB}/releases">GitHub</a>.</p>`;
  const list = ((await gh("/releases?per_page=100")) as GhRelease[]).filter((r) => !r.draft && !r.prerelease);
  return list
    .map((r) => {
      const v = r.tag_name.replace(/^v/, "");
      // GitHub's "Full Changelog" line is a bare URL; each release links to its page instead
      const notes = (r.body || "").replace(/^#+\s.*\n/, "").replace(/^\*\*Full Changelog\*\*:.*$/m, "");
      const body = render(notes).html.replace(/<h[23] id="[^"]*">/g, "<h4>").replace(/<\/h[23]>/g, "</h4>");
      return `<section class="release" id="v${slugify(v)}"><h2><a class="anchor" href="#v${slugify(v)}" aria-hidden="true" tabindex="-1">#</a>${esc(v)}<time datetime="${r.published_at}">${r.published_at.slice(0, 10)}</time></h2>${body}<p class="edit"><a class="ext" href="${r.html_url}" rel="noopener">${esc(v)} on GitHub</a></p></section>`;
    })
    .join("\n");
}

// ---------- layout ----------

const ICON = readFileSync(join(ROOT, "apps/web/public/icon.svg"), "utf8");

function layout(opts: {
  title: string;
  description: string;
  path: string;
  body: string;
  version?: string;
  bodyClass?: string;
}): string {
  const full = opts.path === "/" ? opts.title : `${opts.title} · Inyon`;
  const nav = [
    ["/docs/", "Docs"],
    ["/download/", "Download"],
    ["/docs/changelog/", "Changelog"],
  ]
    .map(([href, label]) => `<a href="${href}"${opts.path.startsWith(href) && !(href === "/docs/" && opts.path.startsWith("/docs/changelog")) ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${ORIGIN}${opts.path}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${ORIGIN}${opts.path}">
<meta property="og:image" content="${ORIGIN}/img/hero-light.webp">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#e9e8e4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1a18" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head>
<body class="${opts.bodyClass ?? ""}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-in">
    <a class="brand" href="/"><span class="mark" aria-hidden="true">${ICON}</span>Inyon${opts.version ? `<span class="ver">${esc(opts.version)}</span>` : ""}</a>
    <nav class="top-nav" aria-label="Site">${nav}</nav>
    <button class="search-btn" type="button" data-search aria-label="Search the docs"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.2 13.2 3.3 3.3"/></svg><span>Search</span><kbd>/</kbd></button>
    <a class="gh" href="${GITHUB}" aria-label="Inyon on GitHub" rel="noopener"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg></a>
    <button class="menu-btn" type="button" data-menu aria-label="Open the menu" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14"/></svg></button>
  </div>
</header>
${opts.body}
<footer class="foot">
  <div class="foot-in">
    <span>Inyon is open source under the MIT licence.</span>
    <nav aria-label="Footer">
      <a href="${GITHUB}" class="ext" rel="noopener">GitHub</a>
      <a href="${GITHUB}/issues" class="ext" rel="noopener">Issues</a>
      <a href="${GITHUB}/blob/main/SECURITY.md" class="ext" rel="noopener">Security</a>
      <a href="https://abhashchakraborty.tech" class="ext" rel="noopener">Made by Abhash Chakraborty</a>
    </nav>
  </div>
</footer>
<div class="search" data-search-dialog hidden>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search the docs">
    <div class="search-field"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.2 13.2 3.3 3.3"/></svg><input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
    <ul class="search-results" role="listbox"></ul>
  </div>
</div>
</body>
</html>
`;
}

function sidebar(current: string): string {
  return NAV.map(
    (group) =>
      `<div class="side-group"><p class="side-title">${group.title}</p><ul>${group.pages
        .map((slug) => {
          const p = pages.get(slug)!;
          return `<li><a href="${url(slug)}"${slug === current ? ' aria-current="page"' : ""}>${esc(p.nav ?? p.title)}</a></li>`;
        })
        .join("")}</ul></div>`,
  ).join("");
}

function docPage(page: Page & { nav?: string }, version?: string): string {
  const order = NAV.flatMap((g) => g.pages);
  const i = order.indexOf(page.slug);
  const prev = i > 0 ? pages.get(order[i - 1]) : undefined;
  const next = i < order.length - 1 ? pages.get(order[i + 1]) : undefined;
  const group = NAV.find((g) => g.pages.includes(page.slug))?.title ?? "";
  const toc = page.toc.filter((t) => t.level === 2);
  const body = `
<div class="docs">
  <aside class="side" data-side aria-label="Docs">${sidebar(page.slug)}</aside>
  <main id="main" class="doc">
    <p class="eyebrow">${esc(group)}</p>
    <h1>${esc(page.title)}</h1>
    ${page.description ? `<p class="lede">${esc(page.description)}</p>` : ""}
    <div class="prose">${page.html}</div>
    <nav class="pager" aria-label="Pages">
      ${prev ? `<a class="prev" href="${url(prev.slug)}"><span>Previous</span>${esc(prev.title)}</a>` : "<span></span>"}
      ${next ? `<a class="next" href="${url(next.slug)}"><span>Next</span>${esc(next.title)}</a>` : "<span></span>"}
    </nav>
    ${page.source ? `<p class="edit"><a class="ext" href="${GITHUB}/blob/main/site/docs/${page.source}" rel="noopener">Edit this page on GitHub</a></p>` : ""}
  </main>
  ${toc.length > 1 ? `<nav class="toc" aria-label="On this page"><p class="side-title">On this page</p><ul>${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join("")}</ul></nav>` : '<div class="toc"></div>'}
</div>`;
  return layout({ title: page.title, description: page.description, path: url(page.slug), body, version });
}

// ---------- build ----------

const pages = new Map<string, Page & { nav?: string }>();

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const latest = await latestRelease().catch((e) => {
    if (MIRROR) throw e;
    console.warn(`release details unavailable: ${e.message}`);
    return null;
  });
  if (MIRROR && latest) {
    console.log(`mirroring ${latest.release.tag}`);
    await mirror(latest.release, latest.raw);
  }
  const version = latest?.release.version;

  // docs
  for (const file of readdirSync(join(SITE, "docs")).filter((f) => f.endsWith(".md"))) {
    const slug = basename(file, ".md");
    const { meta, body } = frontmatter(readFileSync(join(SITE, "docs", file), "utf8"));
    if (!meta.title) throw new Error(`${file}: no title`);
    const { html, toc } = render(body);
    pages.set(slug, { slug, title: meta.title, nav: meta.nav, description: meta.description ?? "", html, toc, source: file });
  }
  pages.set("changelog", {
    slug: "changelog",
    title: "Changelog",
    description: "Every release of Inyon, newest first.",
    html: await changelog().catch((e) => {
      console.warn(`changelog unavailable: ${e.message}`);
      return `<p>The release notes are on <a class="ext" href="${GITHUB}/releases">GitHub</a>.</p>`;
    }),
    toc: [],
  });
  const listed = new Set(NAV.flatMap((g) => g.pages));
  for (const slug of pages.keys()) if (!listed.has(slug)) throw new Error(`site/docs/${slug}.md is not in NAV`);
  for (const slug of listed) if (!pages.has(slug)) throw new Error(`NAV lists ${slug}, which has no page`);

  for (const page of pages.values()) {
    const dir = join(OUT, url(page.slug));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), docPage(page, version));
  }

  // links between pages must land somewhere
  for (const page of pages.values()) {
    for (const [, slug, hash] of page.html.matchAll(/href="\/docs\/(?:([\w-]+)\/)?(#[\w-]+)?"/g)) {
      const target = pages.get(slug ?? "index");
      if (!target) throw new Error(`${page.slug}: link to missing page ${slug}`);
      if (hash && target.slug !== "changelog" && !target.toc.some((t) => `#${t.id}` === hash))
        throw new Error(`${page.slug}: link to missing section ${slug}${hash}`);
    }
  }

  // search index: one entry per page and per section
  const index: { t: string; h?: string; u: string; x: string }[] = [];
  for (const page of pages.values()) {
    if (page.slug === "changelog") continue;
    const parts = page.html.split(/(?=<h[23] id=")/);
    for (const part of parts) {
      const m = part.match(/^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/);
      const text = strip(m ? part.slice(m[0].length) : part)
        .replace(/\bCopy\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      index.push({
        t: page.title,
        h: m ? strip(m[2]).replace(/^#/, "") : undefined,
        u: url(page.slug) + (m ? `#${m[1]}` : ""),
        x: (m ? "" : `${page.description} `) + text.slice(0, 600),
      });
    }
  }
  mkdirSync(join(OUT, "assets"), { recursive: true });
  writeFileSync(join(OUT, "assets/search.json"), JSON.stringify(index));

  // home and download pages
  const fill = (html: string) =>
    html
      .replaceAll("{{version}}", version ? esc(version) : "")
      .replaceAll("{{apk}}", latest ? "/download/inyon.apk" : `${GITHUB}/releases/latest`)
      .replaceAll(
        "{{apk-meta}}",
        latest
          ? `Inyon ${esc(latest.release.version)} · ${mb(latest.release.assets.find((a) => a.name.endsWith(".apk"))?.size ?? 0)}`
          : "From the latest release",
      )
      .replace("{{downloads}}", () => downloadTable(latest?.release))
      .replaceAll("{{github}}", GITHUB);
  const home = readFileSync(join(SITE, "pages/home.html"), "utf8");
  writeFileSync(
    join(OUT, "index.html"),
    layout({
      title: "Inyon: your coding agents, from your phone",
      description:
        "Watch, answer and steer Claude Code, Codex, Gemini CLI, OpenCode and GitHub Copilot running in tmux on your own computers, from your phone or any browser.",
      path: "/",
      body: fill(home),
      version,
      bodyClass: "home",
    }),
  );
  mkdirSync(join(OUT, "download"), { recursive: true });
  writeFileSync(
    join(OUT, "download/index.html"),
    layout({
      title: "Download",
      description: "Download Inyon for Android, Linux, macOS and Windows. Every file is checked against the release's SHA256SUMS.",
      path: "/download/",
      body: fill(readFileSync(join(SITE, "pages/download.html"), "utf8")),
      version,
    }),
  );
  if (latest) {
    const r = latest.release;
    writeFileSync(
      join(OUT, "download/latest.json"),
      JSON.stringify({ version: r.version, tag: r.tag, date: r.date, files: r.assets }, null, 2),
    );
  }
  writeFileSync(
    join(OUT, "404.html"),
    layout({
      title: "Page not found",
      description: "This page doesn't exist.",
      path: "/404.html",
      body: readFileSync(join(SITE, "pages/404.html"), "utf8"),
      version,
    }),
  );

  // static files
  cpSync(join(SITE, "assets"), join(OUT, "assets"), { recursive: true });
  cpSync(join(SITE, "sw.js"), join(OUT, "sw.js"));
  cpSync(join(ROOT, "apps/web/public/icon.svg"), join(OUT, "icon.svg"));
  mkdirSync(join(OUT, "img"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "docs")).filter((f) => /\.(webp|png|svg)$/.test(f)))
    cpSync(join(ROOT, "docs", f), join(OUT, "img", f));
  if (existsSync(join(SITE, "img")))
    for (const f of readdirSync(join(SITE, "img"))) cpSync(join(SITE, "img", f), join(OUT, "img", f));
  writeFileSync(join(OUT, ".nojekyll"), "");
  writeFileSync(join(OUT, "CNAME"), `${new URL(ORIGIN).host}\n`);
  writeFileSync(
    join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/download/", ...[...pages.keys()].map(url)]
      .map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`)
      .join("\n")}\n</urlset>\n`,
  );
  writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  console.log(`built ${pages.size} docs pages into ${OUT}${version ? ` (Inyon ${version})` : ""}`);
}

// ---------- download table ----------

// the .gz files each system needs; Alpine shares Linux's static inyon command and has its own engine
const PLATFORMS: { os: string; arch: string; match: RegExp }[] = [
  { os: "Linux", arch: "x64", match: /-linux-x64\.gz$/ },
  { os: "Linux", arch: "arm64", match: /-linux-arm64\.gz$/ },
  { os: "Alpine (musl)", arch: "x64", match: /^inyon-linux-x64\.gz$|-linux-x64-musl\.gz$/ },
  { os: "Alpine (musl)", arch: "arm64", match: /^inyon-linux-arm64\.gz$|-linux-arm64-musl\.gz$/ },
  { os: "macOS", arch: "Apple silicon", match: /-darwin-arm64\.gz$/ },
  { os: "macOS", arch: "Intel", match: /-darwin-x64\.gz$/ },
  { os: "Windows", arch: "x64", match: /-windows-x64\.exe\.gz$/ },
  { os: "Windows", arch: "arm64", match: /-windows-arm64\.exe\.gz$|-engine-windows-x64\.exe\.gz$/ },
];

function downloadTable(r?: Release): string {
  if (!r) return `<p>The files are on <a class="ext" href="${GITHUB}/releases/latest">the latest release</a>.</p>`;
  const link = (a: Asset) =>
    `<a href="/download/${encodeURIComponent(a.name)}" download><code>${esc(a.name)}</code></a><span class="size">${mb(a.size)}</span>`;
  const rows = PLATFORMS.map((p) => {
    const files = r.assets.filter((a) => p.match.test(a.name));
    if (!files.length) return "";
    return `<tr><th scope="row">${p.os}<span>${p.arch}</span></th><td>${files.map(link).join("<br>")}</td></tr>`;
  }).join("");
  // the rest: anything that isn't one of those programs, compressed or not (the web app's tarball,
  // the APK, the checksums and their signature, the installers)
  const programs = new Set(r.assets.filter((a) => PLATFORMS.some((p) => p.match.test(a.name))).map((a) => a.name));
  const extra = r.assets.filter((a) => !programs.has(a.name) && !programs.has(`${a.name}.gz`));
  return `<div class="table"><table class="files"><thead><tr><th>System</th><th>Files (gzip)</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">Each file is also served uncompressed, without the <code>.gz</code>. The installers pick the right ones for you.</p>
<h2 id="everything-else">Everything else</h2>
<div class="table"><table class="files"><tbody>${extra.map((a) => `<tr><td>${link(a)}</td></tr>`).join("")}</tbody></table></div>`;
}

if (import.meta.main) await main();
