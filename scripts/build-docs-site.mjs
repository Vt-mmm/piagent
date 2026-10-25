#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { icon, iconSprite, iconsUsedIn } from "./docs-site-icons.mjs";
import { NAV, NAV_BY_LOCALE } from "./docs-site-nav.mjs";
import { readReleases, renderChangelogMarkdown, renderHeroPill, renderLatestReleases, renderReleaseNotes } from "./docs-site-releases.mjs";

// Assembles the docs site: one static page per topic, from a shared shell and a
// content fragment each.
//
// The site is served as plain files, so there is no runtime that could stitch a
// shared header into every page. Duplicating that markup by hand across a dozen
// pages is how a navigation entry ends up on eleven of them, so it is generated
// here instead and the output is committed. `--check` fails when the committed
// output no longer matches its source, the same arrangement the capability
// catalog already uses.
//
// Release notes have one source, docs-site/releases.json. It produces the
// Changelog page in both languages, the "latest" cards on the landing page and
// CHANGELOG.md, so the three can never disagree.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "docs-site");
const contentRoot = path.join(siteRoot, "content");

const SITE = {
  title: "Pi Agent Platform",
  origin: "https://piagent.io.vn",
  repo: "https://github.com/Vt-mmm/piagent",
  npm: "https://www.npmjs.com/package/@piagent/platform",
  facebook: "https://www.facebook.com/vinhtam0544/"
};

// Vercel Web Analytics, added here rather than to a page so all locales and
// every generated page carry the same one. It is cookieless and stores no
// identifier in the browser, so the site needs no consent banner -- which is
// the reason to prefer it over an analytics product that would.
//
// The route only exists once Web Analytics is enabled for the Vercel project
// (dashboard -> Analytics -> Enable) and the site is redeployed. Until then the
// request 404s and the page is otherwise unaffected: the inline shim below
// queues calls instead of throwing on an undefined `window.va`.
//
// Enabling also provisions a second, project-unique route that ad blockers do
// not recognise. Swapping this src for that path collects more of the traffic;
// this stable one is used because it does not embed a per-project secret in a
// public repository.
const ANALYTICS_SNIPPET = `    <script>
      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
`;

// Set before first paint so a reader who chose light never sees a dark flash.
const THEME_SNIPPET = `<script>try{var t=localStorage.getItem("piagent-docs-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>`;

const LOCALES = {
  vi: {
    code: "vi",
    label: "VI",
    prefix: "",
    contentRoot,
    nav: NAV_BY_LOCALE.vi,
    ui: {
      breadcrumb: "Docs",
      language: "Ngôn ngữ",
      githubAria: "Mở GitHub repository",
      menu: "Mở menu tài liệu",
      docs: "Tài liệu",
      changelog: "Changelog",
      benchmark: "Benchmark",
      searchAria: "Tìm trong tài liệu",
      searchPlaceholder: "Tìm trong tài liệu…",
      searchEmpty: "Không có trang nào khớp.",
      searchHint: ["↑↓ chọn", "↵ mở", "esc đóng"],
      themeAria: "Đổi giao diện sáng/tối",
      navAria: "Tài liệu",
      pagerAria: "Trang kế tiếp",
      previous: "Trước",
      next: "Tiếp",
      tocAria: "Mục lục trang",
      tocTitle: "Trên trang này",
      editPage: "Sửa trang này",
      externalLinks: "Liên kết ngoài",
      skip: "Tới nội dung",
      copySuccess: "Đã lấy",
      copyFallback: "Chọn lệnh",
      copyLabel: "Sao chép",
      footer: "Pi Agent Platform · MIT · tài liệu tĩnh, không cookie"
    }
  },
  en: {
    code: "en",
    label: "EN",
    prefix: "/en",
    contentRoot: path.join(contentRoot, "en"),
    nav: NAV_BY_LOCALE.en,
    ui: {
      breadcrumb: "Docs",
      language: "Language",
      githubAria: "Open GitHub repository",
      menu: "Open docs menu",
      docs: "Docs",
      changelog: "Changelog",
      benchmark: "Benchmark",
      searchAria: "Search documentation",
      searchPlaceholder: "Search the docs…",
      searchEmpty: "No page matches.",
      searchHint: ["↑↓ select", "↵ open", "esc close"],
      themeAria: "Switch light/dark theme",
      navAria: "Documentation",
      pagerAria: "Adjacent pages",
      previous: "Previous",
      next: "Next",
      tocAria: "Page contents",
      tocTitle: "On this page",
      editPage: "Edit this page",
      externalLinks: "External links",
      skip: "Skip to content",
      copySuccess: "Copied",
      copyFallback: "Select command",
      copyLabel: "Copy",
      footer: "Pi Agent Platform · MIT · static docs, no cookies"
    }
  }
};

const pagesFor = (locale) => locale.nav.flatMap((section) =>
  section.pages.map((page) => ({ ...page, group: section.group }))
);

/** @param {{slug: string, href?: string}} page @returns {string} */
function hrefFor(page, locale) {
  const relative = page.href ?? `/${page.slug}`;
  if (!locale.prefix) return relative;
  return relative === "/" ? `${locale.prefix}/` : `${locale.prefix}${relative}`;
}

/** @param {string} value @returns {string} */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A lead written with inline markup, as plain text for the meta description.
 *
 * Stripping once is not enough: removing `<b>` from `<<b>script>` leaves
 * `<script>`, so a single pass can produce a tag it was meant to remove. The
 * loop runs until the text stops changing. Safety does not rest on this —
 * `escapeHtml` still runs on the result — but a meta description containing
 * stray markup is wrong regardless of whether it is dangerous.
 *
 * @param {string} value
 * @returns {string}
 */
function stripTags(value) {
  let text = value;
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== previous);
  return text;
}

const decodeEntities = (value) => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** @param {string} currentSlug @param {typeof LOCALES.vi} locale @returns {string} */
function renderNav(currentSlug, locale) {
  return locale.nav.map((section) => {
    const links = section.pages
      .map((page) => {
        const current = page.slug === currentSlug;
        const classes = current ? "nav-link current" : "nav-link";
        const aria = current ? ' aria-current="page"' : "";
        return `            <a class="${classes}" href="${hrefFor(page, locale)}"${aria}>${icon(page.icon)}<span>${escapeHtml(page.nav)}</span></a>`;
      })
      .join("\n");
    return `          <div class="nav-group">\n            <p class="nav-title">${escapeHtml(section.group)}</p>\n${links}\n          </div>`;
  }).join("\n");
}

/** @param {ReturnType<typeof pagesFor>[number]} page @param {typeof LOCALES.vi} locale @returns {string} */
function renderBreadcrumb(page, locale) {
  return [
    '            <nav class="breadcrumb" aria-label="Breadcrumb">',
    `              <a href="${hrefFor({ slug: "index", href: "/" }, locale)}">${locale.ui.breadcrumb}</a>`,
    '              <span aria-hidden="true">/</span>',
    `              <span>${escapeHtml(page.group)}</span>`,
    "            </nav>",
    ""
  ].join("\n");
}

/** @param {ReturnType<typeof pagesFor>[number]} page @param {typeof LOCALES.vi} locale @returns {string} */
function renderPageHead(page, locale) {
  const source = page.slug === "whats-new"
    ? "docs-site/releases.json"
    : `docs-site/content/${locale.prefix ? "en/" : ""}${page.slug}.html`;
  return [
    '            <div class="page-head">',
    `              <h1>${escapeHtml(page.title)}</h1>`,
    `              <p>${page.lead}</p>`,
    '              <div class="page-meta">',
    `                <a href="${SITE.repo}/blob/main/${source}" target="_blank" rel="noopener noreferrer">${icon("edit")}${locale.ui.editPage}</a>`,
    "              </div>",
    "            </div>",
    ""
  ].join("\n");
}

/** @param {number} index @param {ReturnType<typeof pagesFor>} pages @param {typeof LOCALES.vi} locale @returns {string} */
function renderPager(index, pages, locale) {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (!previous && !next) return "";
  const parts = [`            <nav class="pager" aria-label="${locale.ui.pagerAria}">`];
  if (previous) {
    parts.push(
      `              <a class="pager-prev" href="${hrefFor(previous, locale)}">`,
      `                <span class="pager-label">← ${locale.ui.previous}</span>`,
      `                <span class="pager-title">${escapeHtml(previous.nav)}</span>`,
      "              </a>"
    );
  }
  if (next) {
    parts.push(
      `              <a class="pager-next" href="${hrefFor(next, locale)}">`,
      `                <span class="pager-label">${locale.ui.next} →</span>`,
      `                <span class="pager-title">${escapeHtml(next.nav)}</span>`,
      "              </a>"
    );
  }
  parts.push("            </nav>", "");
  return parts.join("\n");
}

function renderTopbar(page, locale, version, home) {
  const languageLinks = Object.values(LOCALES).map((candidate) => {
    const current = candidate.code === locale.code;
    const classes = current ? "language-option current" : "language-option";
    const aria = current ? ' aria-current="true"' : "";
    return `<a class="${classes}" href="${hrefFor(page, candidate)}" hreflang="${candidate.code}" lang="${candidate.code}"${aria}>${candidate.label}</a>`;
  }).join("");
  const link = (slug, label) => {
    const current = page.slug === slug ? ' aria-current="page"' : "";
    return `<a href="${hrefFor({ slug }, locale)}"${current}>${label}</a>`;
  };
  const menu = home ? "" : `\n      <button class="icon-button mobile-menu" type="button" data-menu aria-label="${locale.ui.menu}">${icon("menu")}</button>`;
  return `    <header class="topbar">${menu}
      <a class="brand" href="${hrefFor({ slug: "index", href: "/" }, locale)}" aria-label="Pi Agent Platform">
        <span class="brand-mark"><img src="/assets/piagent-logo.svg" alt="" width="28" height="28" /></span>
        <span class="brand-name"><b>Piagent</b> <span>Platform</span></span>
      </a>
      <a class="version-badge" href="${hrefFor({ slug: "whats-new" }, locale)}" data-docs-version="v${version}" title="v${version} docs · ${locale.label}"><span class="dot"></span>v${version}</a>
      <nav class="top-nav" aria-label="${locale.ui.navAria}">
        ${link("quickstart", locale.ui.docs)}
        ${link("whats-new", locale.ui.changelog)}
        ${link("benchmark", locale.ui.benchmark)}
      </nav>
      <span class="top-spacer"></span>
      <button class="search-trigger" type="button" data-search aria-label="${locale.ui.searchAria}">${icon("search")}<span>${locale.ui.searchPlaceholder}</span><kbd>⌘K</kbd></button>
      <div class="top-actions">
        <nav class="language-switch" aria-label="${locale.ui.language}">${languageLinks}</nav>
        <button class="icon-button theme-toggle" type="button" data-theme-toggle aria-label="${locale.ui.themeAria}">${icon("moon", "icon icon-moon")}${icon("sun", "icon icon-sun")}</button>
        <a class="icon-button" href="${SITE.repo}" target="_blank" rel="noopener noreferrer" aria-label="${locale.ui.githubAria}">${icon("github")}</a>
      </div>
    </header>
`;
}

function renderPalette(locale) {
  const hints = locale.ui.searchHint.map((hint) => `<span>${hint}</span>`).join("");
  return `    <div class="palette" data-palette data-index="/assets/search-${locale.code}.json" data-empty="${locale.ui.searchEmpty}" role="dialog" aria-modal="true" aria-label="${locale.ui.searchAria}">
      <div class="palette-box">
        <label class="palette-input">${icon("search")}<input type="search" placeholder="${locale.ui.searchPlaceholder}" aria-label="${locale.ui.searchAria}" autocomplete="off" spellcheck="false" /></label>
        <div class="palette-results" data-results role="listbox"></div>
        <div class="palette-foot">${hints}</div>
      </div>
    </div>
`;
}

function renderFooter(page, locale) {
  const other = locale.code === "vi" ? LOCALES.en : LOCALES.vi;
  return `<footer class="footer">
              <p>${locale.ui.footer}</p>
              <div class="footer-links" aria-label="${locale.ui.externalLinks}">
                <a href="${SITE.repo}" target="_blank" rel="noopener noreferrer">GitHub</a>
                <a href="${SITE.npm}" target="_blank" rel="noopener noreferrer">npm</a>
                <a href="${hrefFor(page, other)}" hreflang="${other.code}">${other.code === "en" ? "English" : "Tiếng Việt"}</a>
                <a href="${SITE.facebook}" target="_blank" rel="noopener noreferrer">Facebook</a>
              </div>
            </footer>`;
}

/**
 * @param {ReturnType<typeof pagesFor>[number]} page
 * @param {number} index
 * @param {string} body
 * @param {string} version
 * @param {typeof LOCALES.vi} locale
 * @param {ReturnType<typeof pagesFor>} pages
 * @returns {string}
 */
function renderPage(page, index, body, version, locale, pages) {
  const home = page.slug === "index";
  const canonical = `${SITE.origin}${hrefFor(page, locale)}`;
  const alternateVi = `${SITE.origin}${hrefFor(page, LOCALES.vi)}`;
  const alternateEn = `${SITE.origin}${hrefFor(page, LOCALES.en)}`;
  const documentTitle = home ? `${SITE.title} — ${stripTags(page.lead).split(":")[0]}` : `${page.title} · ${SITE.title}`;
  const description = stripTags(page.lead);

  const main = home
    ? `    <main id="content" class="home-main" data-article>
${body}
    </main>
    <footer class="site-footer">
      <div class="home-wrap">
        <p>${locale.ui.footer}</p>
        <nav aria-label="${locale.ui.externalLinks}">
          <a href="${hrefFor({ slug: "quickstart" }, locale)}">${locale.ui.docs}</a>
          <a href="${hrefFor({ slug: "whats-new" }, locale)}">${locale.ui.changelog}</a>
          <a href="${SITE.repo}" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="${SITE.npm}" target="_blank" rel="noopener noreferrer">npm</a>
          <a href="${hrefFor(page, locale.code === "vi" ? LOCALES.en : LOCALES.vi)}" hreflang="${locale.code === "vi" ? "en" : "vi"}">${locale.code === "vi" ? "English" : "Tiếng Việt"}</a>
        </nav>
      </div>
    </footer>
`
    : `    <div class="layout with-toc">
      <aside class="sidebar" data-sidebar>
        <nav aria-label="${locale.ui.navAria}">
${renderNav(page.slug, locale)}
        </nav>
      </aside>

      <main id="content">
        <div class="content-shell" data-article>
${renderBreadcrumb(page, locale)}${renderPageHead(page, locale)}${body}
${renderPager(index, pages, locale)}
            ${renderFooter(page, locale)}
        </div>
      </main>

      <aside class="toc" aria-label="${locale.ui.tocAria}">
        <p class="toc-title">${locale.ui.tocTitle}</p>
        <nav data-toc></nav>
      </aside>
    </div>
`;

  const shell = `${renderTopbar(page, locale, version, home)}
${main}${renderPalette(locale)}`;
  const navIcons = pagesFor(locale).map((candidate) => candidate.icon);
  const sprite = iconSprite([...new Set([...iconsUsedIn(shell), ...navIcons, "hash"])].sort());

  return `<!doctype html>
<html lang="${locale.code}" data-copy-success="${locale.ui.copySuccess}" data-copy-fallback="${locale.ui.copyFallback}" data-copy-label="${locale.ui.copyLabel}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(documentTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#fbfbf9" media="(prefers-color-scheme: light)" />
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" hreflang="vi" href="${alternateVi}" />
    <link rel="alternate" hreflang="en" href="${alternateEn}" />
    <link rel="alternate" hreflang="x-default" href="${alternateVi}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(documentTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${SITE.origin}/assets/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    ${THEME_SNIPPET}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;550;600;650;700;750&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/assets/docs.css" />
    <script src="/assets/docs.js" defer></script>
  </head>
  <body${home ? ' class="home"' : ""}>
    ${sprite}
    <a class="skip-link" href="#content">${locale.ui.skip}</a>
${shell}${ANALYTICS_SNIPPET}  </body>
</html>
`;
}

/** Every `<pre>` block in a document, with its inner text unmodified. */
function preBlocks(html) {
  return [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map((match) => match[1]);
}

/**
 * The body is placed into the shell verbatim. Indenting it to line up with the
 * surrounding markup would look tidier in the source and would also rewrite the
 * inside of every `<pre>`, where whitespace is what the reader sees. This
 * refuses to emit a page whose code blocks no longer match the fragment.
 *
 * @param {string} slug
 * @param {string} body
 * @param {string} html
 */
function assertPreBlocksIntact(slug, body, html) {
  const source = preBlocks(body);
  const rendered = preBlocks(html);
  if (source.length !== rendered.length) {
    throw new Error(`${slug}: expected ${source.length} code blocks in the output, found ${rendered.length}`);
  }
  for (const [index, expected] of source.entries()) {
    if (rendered[index] !== expected) {
      throw new Error(`${slug}: code block ${index + 1} was altered between the fragment and the page`);
    }
  }
}

/** Page and heading entries the search palette loads on first use. */
function searchEntry(page, body, locale) {
  const headings = [...body.matchAll(/<h([23])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map(([, , id, text]) => ({ id, text: decodeEntities(stripTags(text)).replace(/\s+/g, " ").trim() }))
    .filter((heading) => heading.text);
  return {
    href: hrefFor(page, locale),
    icon: page.icon,
    group: page.group,
    nav: page.nav,
    title: page.title,
    lead: decodeEntities(stripTags(page.lead)),
    headings
  };
}

function build() {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const version = rootPackage.version;
  const piHost = rootPackage.peerDependencies["@earendil-works/pi-coding-agent"];
  const releases = readReleases(path.join(siteRoot, "releases.json"));
  /** @type {{file: string, html: string}[]} */
  const outputs = [];
  for (const locale of Object.values(LOCALES)) {
    const pages = pagesFor(locale);
    const index = [];
    for (const [position, page] of pages.entries()) {
      const fragment = path.join(locale.contentRoot, `${page.slug}.html`);
      if (!fs.existsSync(fragment)) throw new Error(`missing content fragment: ${path.relative(repoRoot, fragment)}`);
      let body = fs.readFileSync(fragment, "utf8").replace(/\s+$/, "");
      if (body.includes("\t")) throw new Error(`${locale.code}/${page.slug}: content fragment contains a tab character`);
      body = body
        .replace("<!-- releases -->", () => renderReleaseNotes(releases, locale, { escapeHtml, icon }))
        .replace("<!-- latest-releases -->", () => renderLatestReleases(releases, locale, { escapeHtml, icon, hrefFor }))
        .replace("<!-- hero-pill -->", () => renderHeroPill(releases, locale, { escapeHtml, icon, hrefFor }))
        .replaceAll("{{version}}", version)
        .replaceAll("{{piHost}}", piHost)
        .replaceAll("{{releaseCount}}", String(releases.filter((release) => release.status === "stable").length))
        .replace(/\{\{icon:([a-z-]+)\}\}/g, (_, name) => icon(name));
      const html = renderPage(page, position, body, version, locale, pages);
      assertPreBlocksIntact(`${locale.code}/${page.slug}`, body, html);
      const outputDir = locale.prefix ? path.join(siteRoot, locale.code) : siteRoot;
      outputs.push({ file: path.join(outputDir, `${page.slug}.html`), html });
      index.push(searchEntry(page, body, locale));
    }
    outputs.push({ file: path.join(siteRoot, "assets", `search-${locale.code}.json`), html: `${JSON.stringify(index)}\n` });
  }
  outputs.push({ file: path.join(repoRoot, "CHANGELOG.md"), html: renderChangelogMarkdown(releases) });
  return outputs;
}

function main(argv) {
  const check = argv.includes("--check");
  let outputs;
  try {
    outputs = build();
  } catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (check) {
    const stale = outputs.filter((output) => {
      const current = fs.existsSync(output.file) ? fs.readFileSync(output.file, "utf8") : "";
      return current !== output.html;
    });
    if (stale.length > 0) {
      process.stderr.write(
        `FAIL: docs-site output is stale for ${stale.map((item) => path.relative(repoRoot, item.file)).join(", ")}. ` +
        "Run: node scripts/build-docs-site.mjs\n"
      );
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, pages: outputs.length })}\n`);
    return 0;
  }

  for (const output of outputs) {
    fs.mkdirSync(path.dirname(output.file), { recursive: true });
    fs.writeFileSync(output.file, output.html);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, pages: outputs.length, out: path.relative(repoRoot, siteRoot) })}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { LOCALES, NAV, NAV_BY_LOCALE, build, hrefFor, main, pagesFor };
