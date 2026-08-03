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

    assert.equal(viPages.length, 17);
    assert.equal(enPages.length, viPages.length);
    assert.equal(outputs.length, viPages.length * 2);
    assert.deepEqual(enPages.map((page) => page.slug), viPages.map((page) => page.slug));
    assert.equal(hrefFor(viPages[0], LOCALES.vi), "/");
    assert.equal(hrefFor(enPages[0], LOCALES.en), "/en/");
    assert.equal(hrefFor(enPages[1], LOCALES.en), "/en/quickstart");
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
