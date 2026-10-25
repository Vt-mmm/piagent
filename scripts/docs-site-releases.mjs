import fs from "node:fs";

// Release notes, from one source: docs-site/releases.json. Each entry carries
// both languages, so the Changelog page in VI and EN, the landing page's
// "latest" cards and CHANGELOG.md are all drawn from the same facts.

const KINDS = ["breaking", "new", "improved", "fixed", "security"];
const STATUSES = new Set(["stable", "prerelease", "unpublished"]);

const KIND_LABEL = {
  vi: { breaking: "Thay đổi lớn", new: "Mới", improved: "Cải thiện", fixed: "Sửa lỗi", security: "Bảo mật" },
  en: { breaking: "Breaking", new: "New", improved: "Improved", fixed: "Fixed", security: "Security" }
};

const MARKDOWN_HEADING = {
  breaking: "Breaking changes",
  new: "Added",
  improved: "Improved",
  fixed: "Fixed",
  security: "Security"
};

const COPY = {
  vi: {
    requires: "Cần",
    filterAria: "Lọc theo loại thay đổi",
    all: "Tất cả",
    archive: "Các bản trước",
    archiveLead: "Bản cũ hơn, gom theo tháng. Mở một tháng để xem từng thay đổi.",
    prerelease: "bản thử",
    unpublished: "không phát hành",
    latest: "Mới nhất",
    month: (year, month) => `Tháng ${month}/${year}`,
    date: (value) => {
      const [year, month, day] = value.split("-");
      return `${day}/${month}/${year}`;
    },
    readMore: "Xem chi tiết"
  },
  en: {
    requires: "Requires",
    filterAria: "Filter by kind of change",
    all: "All",
    archive: "Earlier releases",
    archiveLead: "Older releases, grouped by month. Open a month to see every change.",
    prerelease: "prerelease",
    unpublished: "not published",
    latest: "Latest",
    month: (year, month) => new Date(Date.UTC(Number(year), Number(month) - 1, 1))
      .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    date: (value) => new Date(`${value}T00:00:00Z`)
      .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
    readMore: "Read more"
  }
};

// The newest releases get a full card; everything older folds into months.
const DETAILED_COUNT = 24;

/** @param {string} file */
function readReleases(file) {
  const releases = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(releases) || releases.length === 0) throw new Error("docs-site/releases.json must be a non-empty array");
  const seen = new Set();
  for (const release of releases) {
    const where = `releases.json ${release?.version ?? "?"}`;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(release.version ?? "")) throw new Error(`${where}: bad version`);
    if (seen.has(release.version)) throw new Error(`${where}: duplicate version`);
    seen.add(release.version);
    if (release.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(release.date ?? "")) throw new Error(`${where}: date must be YYYY-MM-DD or null`);
    if (!STATUSES.has(release.status)) throw new Error(`${where}: status must be stable, prerelease or unpublished`);
    for (const field of ["title", "summary"]) {
      if (!release[field]?.en || !release[field]?.vi) throw new Error(`${where}: ${field} needs en and vi`);
    }
    if (!Array.isArray(release.items) || release.items.length === 0) throw new Error(`${where}: items must be a non-empty array`);
    for (const item of release.items) {
      if (!KINDS.includes(item.kind) || !item.en || !item.vi) throw new Error(`${where}: every item needs a known kind, en and vi`);
    }
    if (release.requires !== null && (!release.requires?.en || !release.requires?.vi)) throw new Error(`${where}: requires needs en and vi, or null`);
  }
  return releases;
}

const anchorFor = (version) => `v${version.replace(/\./g, "-")}`;

/** Text from the JSON, escaped, with `code` spans. */
function inline(text, escapeHtml) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function sortedItems(items) {
  return [...items].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

function statusNote(release, copy) {
  if (release.status === "prerelease") return ` <span class="tag">${copy.prerelease}</span>`;
  if (release.status === "unpublished") return ` <span class="tag">${copy.unpublished}</span>`;
  return "";
}

function renderItems(release, locale, escapeHtml) {
  const labels = KIND_LABEL[locale.code];
  return sortedItems(release.items)
    .map((item) => `      <li data-kind="${item.kind}"><span class="kind kind-${item.kind}">${labels[item.kind]}</span><span>${inline(item[locale.code], escapeHtml)}</span></li>`)
    .join("\n");
}

function renderRelease(release, index, locale, { escapeHtml }) {
  const copy = COPY[locale.code];
  const id = anchorFor(release.version);
  const date = release.date ? `<time class="release-date" datetime="${release.date}">${copy.date(release.date)}</time>` : "";
  const requires = release.requires
    ? `\n    <p class="release-requires"><strong>${copy.requires}:</strong> ${inline(release.requires[locale.code], escapeHtml)}</p>`
    : "";
  return `<article class="release${index === 0 ? " latest" : ""}" id="${id}" data-release>
  <div class="release-meta"><a class="release-version" href="#${id}">v${release.version}</a>${date}</div>
  <div class="release-body">
    <h3 data-toc-skip id="${id}-title">${inline(release.title[locale.code], escapeHtml)}${statusNote(release, copy)}</h3>
    <p>${inline(release.summary[locale.code], escapeHtml)}</p>
    <ul class="release-items">
${renderItems(release, locale, escapeHtml)}
    </ul>${requires}
  </div>
</article>`;
}

function monthKey(release) {
  return release.date ? release.date.slice(0, 7) : "undated";
}

function renderArchive(releases, locale, { escapeHtml }) {
  const copy = COPY[locale.code];
  const months = new Map();
  for (const release of releases) {
    const key = monthKey(release);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(release);
  }
  const groups = [...months.entries()].map(([key, group]) => {
    const [year, month] = key.split("-");
    const label = key === "undated" ? copy.unpublished : copy.month(year, month);
    const rows = group.map((release) => {
      const id = anchorFor(release.version);
      const date = release.date ? ` <span class="release-date">${copy.date(release.date)}</span>` : "";
      return `    <div class="archive-row" id="${id}">
      <div class="archive-head"><a class="release-version" href="#${id}">v${release.version}</a>${date}</div>
      <div class="archive-body">
        <p><strong>${inline(release.title[locale.code], escapeHtml)}</strong>${statusNote(release, copy)} — ${inline(release.summary[locale.code], escapeHtml)}</p>
        <ul class="release-items">
${renderItems(release, locale, escapeHtml).replace(/^/gm, "  ")}
        </ul>
      </div>
    </div>`;
    }).join("\n");
    return `  <details class="release-archive">
    <summary><span>${label}</span><span class="archive-count">${group.length}</span></summary>
${rows}
  </details>`;
  }).join("\n");
  return `<section class="section archive">
  <h2 id="archive">${copy.archive}</h2>
  <p class="section-lead">${copy.archiveLead}</p>
${groups}
</section>`;
}

/** The body of the Changelog page for one locale. */
function renderReleaseNotes(releases, locale, helpers) {
  const copy = COPY[locale.code];
  const labels = KIND_LABEL[locale.code];
  const detailed = releases.filter((release) => release.status !== "prerelease").slice(0, DETAILED_COUNT);
  const detailedSet = new Set(detailed);
  const older = releases.filter((release) => !detailedSet.has(release));
  const filters = ["all", "new", "improved", "fixed", "security"]
    .map((kind, index) => `<button type="button" data-filter-kind="${kind}" aria-pressed="${index === 0}">${kind === "all" ? copy.all : labels[kind]}</button>`)
    .join("");
  return `<div class="release-filter" role="toolbar" aria-label="${copy.filterAria}">${filters}</div>
<section class="section releases" data-releases>
<h2 id="latest" class="sr-only">${copy.latest}</h2>
${detailed.map((release, index) => renderRelease(release, index, locale, helpers)).join("\n")}
</section>
${renderArchive(older, locale, helpers)}`;
}

/** Three cards for the landing page. */
function renderLatestReleases(releases, locale, { escapeHtml, icon, hrefFor }) {
  const copy = COPY[locale.code];
  const changelog = hrefFor({ slug: "whats-new" }, locale);
  return releases.filter((release) => release.status === "stable").slice(0, 3).map((release) => `      <a class="update" href="${changelog}#${anchorFor(release.version)}" data-reveal>
        <span class="update-meta"><span class="release-version">v${release.version}</span>${release.date ? copy.date(release.date) : ""}</span>
        <h3>${inline(release.title[locale.code], escapeHtml)}</h3>
        <p>${inline(release.summary[locale.code], escapeHtml)}</p>
        <span class="update-more">${copy.readMore} ${icon("arrow-right")}</span>
      </a>`).join("\n");
}

/** The pill above the landing headline: the newest stable release. */
function renderHeroPill(releases, locale, { escapeHtml, icon, hrefFor }) {
  const latest = releases.find((release) => release.status === "stable");
  return `<a class="hero-pill" href="${hrefFor({ slug: "whats-new" }, locale)}#${anchorFor(latest.version)}"><b>v${latest.version}</b><span>${inline(latest.title[locale.code], escapeHtml)}</span>${icon("arrow-right")}</a>`;
}

/** CHANGELOG.md, in English, newest first. */
function renderChangelogMarkdown(releases) {
  const lines = [
    "# Changelog",
    "",
    "Every release of Pi Agent Platform (`@piagent/platform`), newest first. Versions follow semantic versioning; prereleases and builds that were tagged but never published are marked.",
    "",
    "This file is generated from `docs-site/releases.json` by `node scripts/build-docs-site.mjs`, which also renders the [Changelog page](https://piagent.io.vn/en/whats-new). Edit the JSON, not this file. When publishing a tag, copy the version's block into the GitHub Release.",
    ""
  ];
  for (const release of releases) {
    const suffix = release.status === "unpublished" ? " (not published)" : "";
    lines.push(release.date ? `## v${release.version} - ${release.date}${suffix}` : `## v${release.version} - not published`, "");
    lines.push(`**${release.title.en}.** ${release.summary.en}`, "");
    for (const kind of KINDS) {
      const items = release.items.filter((item) => item.kind === kind);
      if (items.length === 0) continue;
      lines.push(`### ${MARKDOWN_HEADING[kind]}`, "", ...items.map((item) => `- ${item.en}`), "");
    }
    if (release.requires) lines.push(`Requires: ${release.requires.en}.`, "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export { readReleases, renderChangelogMarkdown, renderHeroPill, renderLatestReleases, renderReleaseNotes };
