#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembles the docs site: one static page per topic, from a shared shell and a
// content fragment each.
//
// The site is served as plain files, so there is no runtime that could stitch a
// shared header into every page. Duplicating that markup by hand across a dozen
// pages is how a navigation entry ends up on eleven of them, so it is generated
// here instead and the output is committed. `--check` fails when the committed
// output no longer matches its source, the same arrangement the capability
// catalog already uses.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "docs-site");
const contentRoot = path.join(siteRoot, "content");

const SITE = {
  title: "Pi Agent Platform Docs",
  origin: "https://piagent.io.vn",
  repo: "https://github.com/Vt-mmm/piagent",
  facebook: "https://www.facebook.com/vinhtam0544/"
};

// Order here is the order in the sidebar, and it is also the order of the
// previous/next links at the foot of each page.
const NAV = [
  {
    group: "Get started",
    pages: [
      {
        slug: "index",
        href: "/",
        nav: "Overview",
        title: "Pi Agent Platform",
        lead: "Nền tảng dùng lại cho nhiều dự án: cài đặt, profile, quyền chạy, MCP, bảo mật và workflow trong một tài liệu."
      },
      {
        slug: "quickstart",
        nav: "Quickstart",
        title: "Step by step cho thành viên mới",
        lead: "Hai lệnh để cài, rồi mở repo, chọn profile, bật quyền phù hợp, chạy task, và verify bằng bằng chứng thật trước khi handoff."
      },
      {
        slug: "scope",
        nav: "Phạm vi platform",
        title: "Platform này nhận phần nào về mình",
        lead: "Agent coding CLI nào cũng đã có cơ chế governance riêng. Platform này không thay thế lớp đó — nó đóng gói một cách vận hành cụ thể trên Pi để mọi repo dùng lại."
      }
    ]
  },
  {
    group: "Build",
    pages: [
      {
        slug: "profiles",
        nav: "Project profile",
        title: "Chọn đúng đường ray cho repo",
        lead: "Profile ghi vào .pi/piagent-profile.json và lock tương ứng. Nó quyết định protected path, verify command và capability mà project cấp."
      },
      {
        slug: "permissions",
        nav: "Permission modes",
        title: "Một command để đổi quyền theo task",
        lead: "Permission mode là session-local override. Đổi mode không sửa project profile."
      },
      {
        slug: "commands",
        nav: "Command catalog",
        title: "Command ngắn, rõ, ít token burn",
        lead: "Ưu tiên dùng slash command vì mỗi command đã gói sẵn policy và flow. Thành viên không cần nhớ lại quy trình trong prompt."
      },
      {
        slug: "workflows",
        nav: "Workflows",
        title: "Các luồng chính",
        lead: "Chọn workflow theo intent thay vì mô tả lại policy trong prompt. Cách này giảm context lãng phí và giữ hành vi nhất quán."
      }
    ]
  },
  {
    group: "MCP",
    pages: [
      {
        slug: "mcp",
        nav: "MCP overview",
        title: "MCP trong Pi Agent Platform",
        lead: "Pi core không hard-code MCP. Platform cài pi-mcp-adapter để dùng MCP theo kiểu token-efficient, và thêm một lớp quản lý server lên trên bốn layer config."
      },
      {
        slug: "mcp-servers",
        nav: "Quản lý server",
        title: "Thêm, xem và gỡ MCP server",
        lead: "piagent-mcp có bề mặt lệnh đầy đủ chứ không chỉ seed preset: add, remove, get, list, enable, disable — trên cả bốn scope."
      },
      {
        slug: "mcp-auth",
        nav: "Auth và readiness",
        title: "Đăng nhập và trạng thái sẵn sàng",
        lead: "Platform không giữ token và không tự chạy OAuth. Nó từ chối ghi secret vào config, và cho biết server nào thật sự gọi được."
      },
      {
        slug: "mcp-approval",
        nav: "Approval gate",
        title: "Server đến từ repo phải được duyệt",
        lead: "Clone một repo lạ rồi mở session không được phép cho tác giả repo đó một process trên máy mình. Quyết định lưu ngoài repo và pin theo digest."
      }
    ]
  },
  {
    group: "Operate",
    pages: [
      {
        slug: "security",
        nav: "Security model",
        title: "Policy enforcement layer, không phải OS sandbox",
        lead: "Platform ưu tiên fail-closed trong bề mặt tool được kiểm soát: khi lock sai, profile sai hoặc bằng chứng thiếu thì chặn, không đoán."
      },
      {
        slug: "architecture",
        nav: "Architecture",
        title: "Kiến trúc repo",
        lead: "Repo này không nhét business logic vào core. Core chỉ giữ policy, prompts, guard, skills và scripts dùng lại được."
      },
      {
        slug: "runtime",
        nav: "Runtime tools",
        title: "Terminal commands cho operator",
        lead: "Nhóm command này chạy ngoài slash command, dùng cho setup, doctor, benchmark, capability và MCP."
      },
      {
        slug: "team",
        nav: "Team usage",
        title: "Team nên dùng như một chuẩn vận hành",
        lead: "Mỗi repo chỉ cần link package, chọn profile đúng và giữ tài liệu project-specific ở repo của dự án đó."
      }
    ]
  }
];

const pages = NAV.flatMap((section) => section.pages.map((page) => ({ ...page, group: section.group })));

/** @param {{slug: string, href?: string}} page @returns {string} */
function hrefFor(page) {
  return page.href ?? `/${page.slug}`;
}

/** @param {string} value @returns {string} */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string} currentSlug @returns {string} */
function renderNav(currentSlug) {
  return NAV.map((section) => {
    const links = section.pages
      .map((page) => {
        const current = page.slug === currentSlug;
        const classes = current ? "nav-link current" : "nav-link";
        const aria = current ? ' aria-current="page"' : "";
        return `            <a class="${classes}" href="${hrefFor(page)}"${aria}>${escapeHtml(page.nav)}</a>`;
      })
      .join("\n");
    return `          <div class="nav-group">\n            <p class="nav-title">${escapeHtml(section.group)}</p>\n${links}\n          </div>`;
  }).join("\n");
}

/** @param {typeof pages[number]} page @returns {string} */
function renderBreadcrumb(page) {
  if (page.slug === "index") return "";
  return [
    '            <nav class="breadcrumb" aria-label="Breadcrumb">',
    '              <a href="/">Docs</a>',
    '              <span aria-hidden="true">/</span>',
    `              <span>${escapeHtml(page.group)}</span>`,
    '              <span aria-hidden="true">/</span>',
    `              <span>${escapeHtml(page.nav)}</span>`,
    "            </nav>",
    ""
  ].join("\n");
}

/** @param {typeof pages[number]} page @returns {string} */
function renderPageHead(page) {
  // The landing page carries its own hero, so it is not given a generated head.
  if (page.slug === "index") return "";
  return [
    '            <div class="page-head">',
    `              <h1>${escapeHtml(page.title)}</h1>`,
    `              <p>${page.lead}</p>`,
    "            </div>",
    ""
  ].join("\n");
}

/** @param {number} index @returns {string} */
function renderPager(index) {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (!previous && !next) return "";
  const parts = ['            <nav class="pager" aria-label="Trang kế tiếp">'];
  if (previous) {
    parts.push(
      `              <a class="pager-prev" href="${hrefFor(previous)}">`,
      '                <span class="pager-label">Trước</span>',
      `                <span class="pager-title">${escapeHtml(previous.nav)}</span>`,
      "              </a>"
    );
  }
  if (next) {
    parts.push(
      `              <a class="pager-next" href="${hrefFor(next)}">`,
      '                <span class="pager-label">Tiếp</span>',
      `                <span class="pager-title">${escapeHtml(next.nav)}</span>`,
      "              </a>"
    );
  }
  parts.push("            </nav>", "");
  return parts.join("\n");
}

/**
 * @param {typeof pages[number]} page
 * @param {number} index
 * @param {string} body
 * @param {string} version
 * @returns {string}
 */
function renderPage(page, index, body, version) {
  const canonical = page.slug === "index" ? `${SITE.origin}/` : `${SITE.origin}${hrefFor(page)}`;
  const documentTitle = page.slug === "index" ? SITE.title : `${page.title} · ${SITE.title}`;
  const description = page.lead.replace(/<[^>]+>/g, "");

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(documentTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#050505" />
    <link rel="canonical" href="${canonical}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta property="og:title" content="${escapeHtml(documentTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${canonical}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/assets/docs.css" />
    <script src="/assets/docs.js" defer></script>
  </head>
  <body>
    <header class="topbar">
      <a class="brand" href="/" aria-label="Pi Agent Platform">
        <span class="brand-mark"><img src="/assets/piagent-logo.svg" alt="" /></span>
        <span>Pi Agent Platform</span>
      </a>
      <div class="top-actions">
        <span class="pill"><span class="pill-dot"></span>v${version} docs</span>
        <a class="button social" href="${SITE.repo}" target="_blank" rel="noopener noreferrer" aria-label="Mở GitHub repository">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          GitHub
        </a>
        <button class="button mobile-menu" type="button" data-menu>Lộ trình</button>
        <a class="button" href="/commands">Commands</a>
      </div>
    </header>

    <div class="layout with-toc">
      <aside class="sidebar" data-sidebar>
        <div class="sidebar-search" aria-label="Tìm trong tài liệu">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Zm5.3-1.7 4.4 4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <input type="search" placeholder="Tìm trang" data-filter />
        </div>

        <nav aria-label="Tài liệu">
${renderNav(page.slug)}
        </nav>
      </aside>

      <main>
        <div class="content-shell" data-article>
${renderBreadcrumb(page)}${renderPageHead(page)}${body}
${renderPager(index)}
            <footer class="footer">
              <p>Pi Agent Platform docs · static HTML · governed agent workflow</p>
              <div class="footer-links" aria-label="External links">
                <a href="${SITE.origin}" target="_blank" rel="noopener noreferrer">piagent.io.vn</a>
                <a href="${SITE.repo}" target="_blank" rel="noopener noreferrer">GitHub repository</a>
                <a href="${SITE.facebook}" target="_blank" rel="noopener noreferrer">Facebook profile</a>
              </div>
            </footer>
        </div>
      </main>

      <aside class="toc" aria-label="Mục lục trang">
        <p class="toc-title">Trên trang này</p>
        <nav data-toc></nav>
      </aside>
    </div>
  </body>
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

function build() {
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  /** @type {{file: string, html: string}[]} */
  const outputs = [];
  for (const [index, page] of pages.entries()) {
    const fragment = path.join(contentRoot, `${page.slug}.html`);
    if (!fs.existsSync(fragment)) throw new Error(`missing content fragment: ${path.relative(repoRoot, fragment)}`);
    const body = fs.readFileSync(fragment, "utf8").replace(/\s+$/, "");
    if (body.includes("\t")) throw new Error(`${page.slug}: content fragment contains a tab character`);
    const html = renderPage(page, index, body, version);
    assertPreBlocksIntact(page.slug, body, html);
    outputs.push({ file: path.join(siteRoot, `${page.slug}.html`), html });
  }
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
        `FAIL: docs-site output is stale for ${stale.map((item) => path.basename(item.file)).join(", ")}. ` +
        "Run: node scripts/build-docs-site.mjs\n"
      );
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, pages: outputs.length })}\n`);
    return 0;
  }

  for (const output of outputs) fs.writeFileSync(output.file, output.html);
  process.stdout.write(`${JSON.stringify({ ok: true, pages: outputs.length, out: path.relative(repoRoot, siteRoot) })}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { NAV, build, main };
