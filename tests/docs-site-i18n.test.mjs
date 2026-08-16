import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { LOCALES, build, hrefFor, pagesFor } from "../scripts/build-docs-site.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;

function renderedPage(outputs, locale, slug) {
  const directory = locale.code === "vi" ? "docs-site" : `docs-site/${locale.code}`;
  const expected = path.join(repositoryRoot, directory, `${slug}.html`);
  const output = outputs.find((item) => item.file === expected);
  assert.ok(output, `missing generated ${locale.code}/${slug}`);
  return output.html;
}

describe("bilingual docs site", () => {
  it("builds a complete VI and EN page set with stable paths", () => {
    const outputs = build();
    const viPages = pagesFor(LOCALES.vi);
    const enPages = pagesFor(LOCALES.en);

    assert.equal(viPages.length, 18);
    assert.equal(enPages.length, viPages.length);
    assert.equal(outputs.length, viPages.length * 2);
    assert.deepEqual(enPages.map((page) => page.slug), viPages.map((page) => page.slug));
    assert.equal(hrefFor(viPages[0], LOCALES.vi), "/");
    assert.equal(hrefFor(enPages[0], LOCALES.en), "/en/");
    assert.equal(hrefFor(enPages[1], LOCALES.en), "/en/quickstart");
    assert.equal(hrefFor(viPages[2], LOCALES.vi), "/whats-new");
    assert.equal(hrefFor(enPages[2], LOCALES.en), "/en/whats-new");
  });

  it("emits language-specific canonical, alternates, controls, and copy labels", () => {
    const outputs = build();
    for (const locale of Object.values(LOCALES)) {
      for (const page of pagesFor(locale)) {
        const html = renderedPage(outputs, locale, page.slug);
        const viHref = hrefFor(page, LOCALES.vi);
        const enHref = hrefFor(page, LOCALES.en);

        assert.match(html, new RegExp(`<html lang="${locale.code}"`));
        assert.ok(html.includes(`<link rel="canonical" href="https://piagent.io.vn${hrefFor(page, locale)}" />`));
        assert.ok(html.includes(`<link rel="alternate" hreflang="vi" href="https://piagent.io.vn${viHref}" />`));
        assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="https://piagent.io.vn${enHref}" />`));
        assert.ok(html.includes(`href="${viHref}" hreflang="vi" lang="vi"`));
        assert.ok(html.includes(`href="${enHref}" hreflang="en" lang="en"`));
        assert.ok(html.includes(`data-copy-success="${locale.ui.copySuccess}"`));
        assert.ok(html.includes(`v${packageVersion} docs · ${locale.label}`));
      }
    }
  });

  it("keeps every English fragment on English internal routes", () => {
    const slugs = new Set(pagesFor(LOCALES.en).map((page) => page.slug));
    for (const page of pagesFor(LOCALES.en)) {
      const file = path.join(repositoryRoot, "docs-site", "content", "en", `${page.slug}.html`);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/href="\/(?!\/)([^"#?]+)(?:[?#][^"]*)?"/g)) {
        const route = match[1].replace(/\/$/, "");
        if (!route.startsWith("en/")) {
          const rootSlug = route || "index";
          assert.ok(!slugs.has(rootSlug), `${page.slug} links to VI route /${route}`);
        }
      }
    }
  });

  it("documents how inspection commands fit into the workflow", () => {
    const outputs = build();
    const vi = renderedPage(outputs, LOCALES.vi, "workflows");
    const en = renderedPage(outputs, LOCALES.en, "workflows");
    const commands = ["/task-preflight", "/piagent-status", "/usage efficiency", "/piagent-orchestration"];

    assert.ok(vi.includes('id="command-anh-huong-gi"'));
    assert.ok(en.includes('id="command-effects"'));
    assert.match(vi, /Không có command bắt buộc mới/);
    assert.match(en, /No new command is mandatory/);
    for (const command of commands) {
      assert.ok(vi.includes(command), `VI workflow page is missing ${command}`);
      assert.ok(en.includes(command), `EN workflow page is missing ${command}`);
    }
  });

  it("documents every terminal command the package installs", () => {
    // Ten shipped commands appeared nowhere on the site, including the two the
    // v1.4.0 headline feature is driven by. A command a user cannot find is a
    // command they do not have, and nothing failed when one was added without
    // a page to mention it.
    const bins = Object.keys(JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
    ).bin);
    const content = fs.readdirSync(path.join(repositoryRoot, "docs-site", "content"), { recursive: true })
      .filter((entry) => String(entry).endsWith(".html"))
      .map((entry) => fs.readFileSync(path.join(repositoryRoot, "docs-site", "content", String(entry)), "utf8"))
      .join("\n");
    // `piagent-dashboard` and `piagent-explain` are documented in their
    // subcommand form, which is the form a reader should learn, so either
    // spelling counts as documented.
    const documented = (bin) =>
      content.includes(bin) || content.includes(bin.replace(/^piagent-/, "piagent "));
    assert.deepEqual(bins.filter((bin) => !documented(bin)), [],
      "every installed command must appear somewhere in docs-site/content");
  });

  it("resolves every generated internal link to a committed static file", () => {
    const outputs = build();
    const siteRoot = path.join(repositoryRoot, "docs-site");
    for (const output of outputs) {
      for (const match of output.html.matchAll(/href="(\/[^"\s]*)"/g)) {
        const pathname = new URL(match[1], "https://piagent.io.vn").pathname;
        const requested = pathname === "/" ? "/index.html" : pathname;
        const candidate = path.join(siteRoot, requested);
        const possible = path.extname(candidate)
          ? [candidate]
          : [candidate, `${candidate}.html`, path.join(candidate, "index.html")];
        assert.ok(possible.some((file) => fs.existsSync(file)), `${path.relative(siteRoot, output.file)} has broken link ${match[1]}`);
      }
    }
  });

  it("keeps the mobile shell one-column after the desktop TOC rules", () => {
    const css = fs.readFileSync(path.join(repositoryRoot, "docs-site", "assets", "docs.css"), "utf8");
    const desktopTocRule = css.indexOf(".layout.with-toc {");
    const mobileOverride = css.lastIndexOf("@media (max-width: 1020px)");
    assert.ok(desktopTocRule >= 0);
    assert.ok(mobileOverride > desktopTocRule, "mobile override must follow the desktop TOC grid");
    assert.match(css.slice(mobileOverride), /\.layout\.with-toc\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(css.slice(mobileOverride), /\.toc\s*\{\s*display:\s*none/);
  });
});

describe("docs site analytics", () => {
  // The snippet lives in the shell rather than in any page fragment, so a page
  // added later inherits it. Assert that across every generated page: a page
  // that silently opts out of measurement is invisible in exactly the way that
  // makes traffic numbers wrong without looking wrong.
  const pages = fs.readdirSync(path.join(repositoryRoot, "docs-site"))
    .filter((name) => name.endsWith(".html"))
    .map((name) => path.join("docs-site", name))
    .concat(fs.readdirSync(path.join(repositoryRoot, "docs-site", "en"))
      .filter((name) => name.endsWith(".html"))
      .map((name) => path.join("docs-site", "en", name)));

  it("generates both locales", () => {
    assert.ok(pages.length >= 30, `only found ${pages.length} pages`);
  });

  for (const page of pages) {
    it(`${page} loads the analytics script exactly once`, () => {
      const html = fs.readFileSync(path.join(repositoryRoot, page), "utf8");
      assert.equal((html.match(/_vercel\/insights\/script\.js/g) ?? []).length, 1, page);
      // The shim has to be there too: without it a call made before the
      // deferred script lands throws on an undefined window.va.
      assert.match(html, /window\.va = window\.va \|\|/);
      // Deferred, so measurement never blocks first paint on a docs page.
      assert.match(html, /<script defer src="\/_vercel\/insights\/script\.js"><\/script>/);
      // Inside the document, before </body> -- a tag after it is not parsed
      // where it was written and silently moves.
      assert.ok(html.indexOf("_vercel/insights") < html.indexOf("</body>"), page);
    });
  }

  it("keeps the analytics host first-party so no consent banner is owed", () => {
    // A third-party analytics origin would need a cookie banner on a docs site
    // that currently ships none. Same-origin /_vercel/* is what avoids that.
    const html = fs.readFileSync(path.join(repositoryRoot, "docs-site", "index.html"), "utf8");
    const sources = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src);
    for (const src of sources) assert.ok(src.startsWith("/"), `third-party script: ${src}`);
  });
});
