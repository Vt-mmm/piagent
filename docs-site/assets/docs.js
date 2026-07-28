// Behaviour shared by every docs page. Loaded with `defer`, so the DOM is parsed
// before any of this runs and no page needs an inline script of its own.

const sidebar = document.querySelector("[data-sidebar]");
const menuButton = document.querySelector("[data-menu]");
const filterInput = document.querySelector("[data-filter]");
const navLinks = Array.from(document.querySelectorAll(".nav-link"));

menuButton?.addEventListener("click", () => {
  sidebar?.classList.toggle("open");
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => sidebar?.classList.remove("open"));
});

// The filter hides whole groups once none of their links match, so a search that
// finds nothing in a group does not leave its heading floating over a gap.
filterInput?.addEventListener("input", (event) => {
  const value = event.target.value.trim().toLowerCase();
  navLinks.forEach((link) => {
    const text = link.textContent.toLowerCase();
    link.style.display = !value || text.includes(value) ? "flex" : "none";
  });
  document.querySelectorAll(".nav-group").forEach((group) => {
    const visible = Array.from(group.querySelectorAll(".nav-link")).some((link) => link.style.display !== "none");
    group.style.display = visible ? "" : "none";
  });
});

// Table of contents, built from the headings the page actually has. Generating it
// here rather than writing it into each page means a heading can never be renamed
// in the prose and left stale in the sidebar.
const tocHost = document.querySelector("[data-toc]");
const article = document.querySelector("[data-article]");

if (tocHost && article) {
  const headings = Array.from(article.querySelectorAll("h2[id], h3[id]"));
  if (headings.length < 2) {
    tocHost.remove();
    document.querySelector(".layout")?.classList.remove("with-toc");
  } else {
    for (const heading of headings) {
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent.trim();
      if (heading.tagName === "H3") link.classList.add("toc-h3");
      tocHost.append(link);
    }

    const tocLinks = Array.from(tocHost.querySelectorAll("a"));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        for (const link of tocLinks) {
          link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`);
        }
      },
      { rootMargin: "-12% 0px -70% 0px", threshold: [0.1, 0.5, 1] }
    );
    for (const heading of headings) observer.observe(heading);
  }
}

// Copy buttons carry the command in an attribute so the visible text can stay
// formatted; the label says what happened and goes back on its own.
document.querySelectorAll("[data-clip]").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-clip") || "";
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Đã lấy";
    } catch {
      button.textContent = "Chọn lệnh";
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  });
});
