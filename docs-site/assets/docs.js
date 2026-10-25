// Behaviour shared by every docs page. Loaded with `defer`, so the DOM is parsed
// before any of this runs and no page needs an inline script of its own (the
// theme is the one exception: it is set in <head> so the page never flashes).

const root = document.documentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Storage can be missing or throw (private windows, blocked site data). */
const store = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* the page works without it */
    }
  }
};

const ICON_COPY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const ICON_CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

// ---------- Theme ----------

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const current = root.dataset.theme
    || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = current === "light" ? "dark" : "light";
  root.dataset.theme = next;
  store.set("piagent-docs-theme", next);
});

// ---------- Sidebar (mobile) ----------

const sidebar = document.querySelector("[data-sidebar]");
document.querySelector("[data-menu]")?.addEventListener("click", () => {
  sidebar?.classList.toggle("open");
});
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => sidebar?.classList.remove("open"));
});
document.addEventListener("click", (event) => {
  if (!sidebar?.classList.contains("open")) return;
  if (sidebar.contains(event.target) || event.target.closest("[data-menu]")) return;
  sidebar.classList.remove("open");
});

// ---------- Copy ----------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Buttons that carry their command in an attribute keep the visible text
// formatted; the label says what happened and goes back on its own.
document.querySelectorAll("[data-clip]").forEach((button) => {
  button.addEventListener("click", async () => {
    const ok = await copyText(button.getAttribute("data-clip") || "");
    const original = button.innerHTML;
    const iconOnly = !button.textContent.trim();
    if (iconOnly) {
      button.innerHTML = ok ? ICON_CHECK : ICON_COPY;
    } else {
      button.textContent = ok ? root.dataset.copySuccess || "Copied" : root.dataset.copyFallback || "Select command";
    }
    button.classList.toggle("done", ok);
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove("done");
    }, 1400);
  });
});

// Every other code block gets an icon button. Comments after `#` are not copied.
document.querySelectorAll("[data-article] pre").forEach((pre) => {
  if (pre.closest(".command-card")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "code-copy";
  button.setAttribute("aria-label", root.dataset.copyLabel || "Copy");
  button.innerHTML = ICON_COPY;
  button.addEventListener("click", async () => {
    const text = pre.innerText.split("\n").map((line) => line.replace(/\s+#\s.*$/, "")).join("\n").trim();
    const ok = await copyText(text);
    button.innerHTML = ok ? ICON_CHECK : ICON_COPY;
    button.classList.toggle("done", ok);
    setTimeout(() => {
      button.innerHTML = ICON_COPY;
      button.classList.remove("done");
    }, 1400);
  });
  pre.append(button);
});

// ---------- Tabs ----------
// A tab group with `data-tabs="os"` remembers its choice, and every other group
// with the same name on the site follows it.

function selectTab(group, value) {
  const buttons = group.querySelectorAll(":scope > .tab-list [data-tab]");
  if (![...buttons].some((button) => button.dataset.tab === value)) return;
  buttons.forEach((button) => {
    const selected = button.dataset.tab === value;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  group.querySelectorAll(":scope > [data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== value;
  });
}

function detectOs() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  return "linux";
}

document.querySelectorAll("[data-tabs]").forEach((group) => {
  const name = group.dataset.tabs;
  const saved = store.get(`piagent-docs-tab-${name}`) || (name === "os" ? detectOs() : null);
  if (saved) selectTab(group, saved === "linux" && !group.querySelector('[data-tab="linux"]') ? "macos" : saved);
  group.querySelectorAll(":scope > .tab-list [data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      store.set(`piagent-docs-tab-${name}`, button.dataset.tab);
      document.querySelectorAll(`[data-tabs="${name}"]`).forEach((peer) => selectTab(peer, button.dataset.tab));
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const all = [...group.querySelectorAll(":scope > .tab-list [data-tab]")];
      const next = all[(all.indexOf(button) + (event.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
      next.focus();
      next.click();
    });
  });
});

// ---------- Table of contents and heading anchors ----------
// Built from the headings the page actually has, so a heading can never be
// renamed in the prose and left stale in the sidebar.

const tocHost = document.querySelector("[data-toc]");
const article = document.querySelector("[data-article]");

if (article) {
  for (const heading of article.querySelectorAll("h2[id], h3[id]")) {
    const anchor = document.createElement("a");
    anchor.className = "heading-anchor";
    anchor.href = `#${heading.id}`;
    anchor.setAttribute("aria-hidden", "true");
    anchor.tabIndex = -1;
    anchor.textContent = "#";
    heading.prepend(anchor);
  }
}

if (tocHost && article) {
  const headings = Array.from(article.querySelectorAll("h2[id], h3[id]")).filter((heading) => !heading.hasAttribute("data-toc-skip"));
  if (headings.length < 2) {
    tocHost.closest(".toc")?.remove();
    document.querySelector(".layout")?.classList.remove("with-toc");
  } else {
    for (const heading of headings) {
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent.replace(/^#/, "").trim();
      if (heading.tagName === "H3") link.classList.add("toc-h3");
      tocHost.append(link);
    }
    const tocLinks = Array.from(tocHost.querySelectorAll("a"));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        for (const link of tocLinks) {
          link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`);
        }
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: [0, 1] }
    );
    for (const heading of headings) observer.observe(heading);
  }
}

// ---------- Search palette (⌘K) ----------

const palette = document.querySelector("[data-palette]");
const paletteInput = palette?.querySelector("input");
const paletteResults = palette?.querySelector("[data-results]");
let searchIndex = null;
let hits = [];
let active = 0;

function normalize(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

async function loadIndex() {
  if (searchIndex) return searchIndex;
  try {
    const response = await fetch(palette.dataset.index);
    const pages = await response.json();
    searchIndex = pages.flatMap((page) => [
      { title: page.title, sub: page.group, href: page.href, icon: page.icon, text: normalize(`${page.title} ${page.nav} ${page.lead}`), weight: 2 },
      ...page.headings.map((heading) => ({
        title: heading.text,
        sub: page.nav,
        href: `${page.href}#${heading.id}`,
        icon: "hash",
        text: normalize(heading.text),
        weight: 1
      }))
    ]);
  } catch {
    searchIndex = [];
  }
  return searchIndex;
}

function iconSvg(name) {
  return document.querySelector(`#icon-${name}`) ? `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>` : "";
}

function renderHits() {
  if (!paletteResults) return;
  if (hits.length === 0) {
    paletteResults.innerHTML = `<p class="palette-empty">${palette.dataset.empty || "No results"}</p>`;
    return;
  }
  paletteResults.innerHTML = "";
  hits.forEach((hit, index) => {
    const link = document.createElement("a");
    link.href = hit.href;
    link.setAttribute("role", "option");
    link.setAttribute("aria-selected", String(index === active));
    link.innerHTML = `${iconSvg(hit.icon)}<span><span class="hit-title"></span><span class="hit-sub"></span></span>`;
    link.querySelector(".hit-title").textContent = hit.title;
    link.querySelector(".hit-sub").textContent = hit.sub;
    link.addEventListener("mousemove", () => {
      if (active === index) return;
      active = index;
      paletteResults.querySelectorAll("a").forEach((item, i) => item.setAttribute("aria-selected", String(i === active)));
    });
    paletteResults.append(link);
  });
}

async function runSearch() {
  const index = await loadIndex();
  const query = normalize(paletteInput.value.trim());
  const words = query.split(/\s+/).filter(Boolean);
  hits = (words.length === 0
    ? index.filter((item) => item.weight === 2)
    : index
      .map((item) => {
        if (!words.every((word) => item.text.includes(word))) return null;
        const starts = normalize(item.title).startsWith(words[0]) ? 2 : 0;
        return { ...item, score: item.weight + starts };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
  ).slice(0, 12);
  active = 0;
  renderHits();
}

function openPalette() {
  if (!palette) return;
  palette.classList.add("open");
  paletteInput.value = "";
  runSearch();
  requestAnimationFrame(() => paletteInput.focus());
}

function closePalette() {
  palette?.classList.remove("open");
}

document.querySelectorAll("[data-search]").forEach((button) => button.addEventListener("click", openPalette));
palette?.addEventListener("click", (event) => {
  if (event.target === palette) closePalette();
});
paletteInput?.addEventListener("input", runSearch);
paletteInput?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (hits.length === 0) return;
    active = (active + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
    const items = paletteResults.querySelectorAll("a");
    items.forEach((item, i) => item.setAttribute("aria-selected", String(i === active)));
    items[active]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && hits[active]) {
    window.location.href = hits[active].href;
    closePalette();
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    palette?.classList.contains("open") ? closePalette() : openPalette();
  } else if (event.key === "Escape") {
    closePalette();
    sidebar?.classList.remove("open");
  } else if (event.key === "/" && !/input|textarea/i.test(document.activeElement?.tagName || "")) {
    event.preventDefault();
    openPalette();
  }
});

// ---------- Landing page effects ----------
// Content is in the HTML and readable without JavaScript. Effects only add
// motion on top, use transform and opacity, and stand down for reduced motion.

const revealTargets = document.querySelectorAll("[data-reveal]");
if (revealTargets.length > 0 && !reducedMotion && "IntersectionObserver" in window) {
  root.classList.add("reveal-ready");
  const revealObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      revealObserver.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  revealTargets.forEach((target) => revealObserver.observe(target));
} else {
  revealTargets.forEach((target) => target.classList.add("in"));
}

// Count-up: the real number is already in the markup; this replays it once.
document.querySelectorAll("[data-count]").forEach((node) => {
  const target = Number(node.dataset.count);
  if (!Number.isFinite(target) || reducedMotion) return;
  const decimals = Number(node.dataset.decimals || 0);
  const format = (value) => value.toLocaleString(root.lang === "vi" ? "vi-VN" : "en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const finalText = node.textContent;
  const observer = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    observer.disconnect();
    const start = performance.now();
    const duration = 1200;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(2, -10 * progress);
      node.textContent = progress < 1 ? format(target * eased) : finalText;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { threshold: 0.6 });
  observer.observe(node);
});

// Spotlight on feature tiles: one listener for the grid, one frame per move.
document.querySelectorAll("[data-spotlight]").forEach((grid) => {
  if (!window.matchMedia("(hover: hover)").matches) return;
  let frame = 0;
  grid.addEventListener("pointermove", (event) => {
    const tile = event.target.closest(".tile");
    if (!tile || frame) return;
    frame = requestAnimationFrame(() => {
      const rect = tile.getBoundingClientRect();
      tile.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      tile.style.setProperty("--my", `${event.clientY - rect.top}px`);
      frame = 0;
    });
  });
});

// Flow line draws itself when the section comes into view.
document.querySelectorAll("[data-flow]").forEach((flow) => {
  if (reducedMotion) {
    flow.classList.add("in");
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    flow.classList.add("in");
    observer.disconnect();
  }, { threshold: 0.4 });
  observer.observe(flow);
});

// Terminal demo: lines appear in order, the prompt types, then it loops while
// on screen. With reduced motion every line is shown at once.
document.querySelectorAll("[data-term]").forEach((term) => {
  const lines = [...term.querySelectorAll(".term-line, .term-card, .term-result")];
  const typed = term.querySelector("[data-type]");
  const fullText = typed?.dataset.type || "";
  if (reducedMotion) {
    lines.forEach((line) => line.classList.add("show"));
    if (typed) typed.textContent = fullText;
    return;
  }
  let timers = [];
  let running = false;
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const play = () => {
    clear();
    running = true;
    lines.forEach((line) => line.classList.remove("show"));
    if (typed) typed.textContent = "";
    let at = 300;
    if (typed) {
      lines[0]?.classList.add("show");
      for (let i = 1; i <= fullText.length; i += 1) {
        timers.push(setTimeout(() => {
          typed.textContent = fullText.slice(0, i);
        }, at));
        at += 28;
      }
      at += 350;
    }
    lines.forEach((line, index) => {
      if (typed && index === 0) return;
      const pause = Number(line.dataset.wait || 520);
      at += pause;
      timers.push(setTimeout(() => line.classList.add("show"), at));
    });
    timers.push(setTimeout(() => {
      if (running) play();
    }, at + 6000));
  };
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !running) play();
    if (!entries[0].isIntersecting && running) {
      running = false;
      clear();
      lines.forEach((line) => line.classList.add("show"));
      if (typed) typed.textContent = fullText;
    }
  }, { threshold: 0.25 });
  observer.observe(term);
});

// Screenshot gallery: tab buttons swap the image and caption in place.
document.querySelectorAll("[data-gallery]").forEach((gallery) => {
  const image = gallery.querySelector("img");
  const caption = gallery.querySelector("figcaption");
  gallery.querySelectorAll("[data-shot]").forEach((button) => {
    button.addEventListener("click", () => {
      gallery.querySelectorAll("[data-shot]").forEach((peer) => peer.setAttribute("aria-selected", String(peer === button)));
      image.style.opacity = "0";
      const next = new Image();
      next.src = button.dataset.shot;
      next.onload = () => {
        image.src = button.dataset.shot;
        image.alt = button.dataset.alt || "";
        caption.textContent = button.dataset.caption || "";
        image.style.opacity = "1";
      };
    });
  });
});

// Changelog filter: show only the items of one kind, and hide releases that
// have none of it.
const releaseFilter = document.querySelector(".release-filter");
releaseFilter?.querySelectorAll("[data-filter-kind]").forEach((button) => {
  button.addEventListener("click", () => {
    const kind = button.dataset.filterKind;
    releaseFilter.querySelectorAll("[data-filter-kind]").forEach((peer) => peer.setAttribute("aria-pressed", String(peer === button)));
    document.querySelectorAll("[data-releases] [data-release], .archive-row").forEach((release) => {
      let shown = 0;
      release.querySelectorAll("[data-kind]").forEach((item) => {
        const visible = kind === "all" || item.dataset.kind === kind;
        item.hidden = !visible;
        if (visible) shown += 1;
      });
      release.hidden = shown === 0;
    });
    document.querySelectorAll(".release-archive").forEach((group) => {
      group.hidden = !group.querySelector(".archive-row:not([hidden])");
      if (kind !== "all" && !group.hidden) group.open = true;
    });
  });
});
