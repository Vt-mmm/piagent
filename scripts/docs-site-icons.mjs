// Line icons for the docs site, drawn on a 24px grid with a 1.75px stroke so
// they sit at the same weight as 14–15px text. Each page carries one inline
// sprite of the icons it uses and refers to them with <use>, so an icon costs
// one <symbol> per page rather than a request or a repeated path.

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5V12m0 0-5.2 5.2M12 12l5.2 5.2"/>',
  rocket: '<path d="M5.5 15.5C4 17 3.5 19.5 3.5 20.5c1 0 3.5-.5 5-2"/><path d="M9 15 6.5 12.5C8 8.5 11.5 4.5 20 4c-.5 8.5-4.5 12-8.5 13.5z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 5.3 6.7M4 3v4h4"/><path d="M4 13a8 8 0 0 0 14.7 4.3M20 21v-4h-4"/>',
  sparkles: '<path d="M11 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path d="M19 15v5M16.5 17.5h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4"/>',
  branch: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="7.5" r="2"/><path d="M6 7.5v9M18 9.5c0 4.5-5 4-11 7.5"/>',
  plug: '<path d="M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  "shield-check": '<path d="M12 3 4.5 6v5.5c0 4.8 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.7 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.8 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.7 7.5-9.5V6z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5" opacity=".55"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8.5 16v-5M12.5 16V8M16.5 16v-3"/>',
  wrench: '<path d="M15 6.5a4.5 4.5 0 0 1-6 6l-5 5L6.5 20l5-5a4.5 4.5 0 0 0 6-6L15 11.5l-2.5-2.5z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  "arrow-up-right": '<path d="M7 17 17 7M8 7h9v9"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M19 19v2H6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  eye: '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="3"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  diff: '<path d="M6 3v12M3 6h6M15 18h6"/><rect x="13" y="3" width="8" height="8" rx="2" opacity=".55"/><rect x="3" y="13" width="8" height="8" rx="2" opacity=".55"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h0a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  zap: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
  box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  apple: '<path d="M16 3.5c-1 .3-2.4 1.3-2.6 3 1.2.1 2.4-.8 2.6-3zM12 8c-1.5-1-5-1-6 2.5S6.5 19 9 20c1.2.5 2-.4 3-.4s1.8.9 3 .4c1.4-.6 2.5-2.7 3-4.5-2.5-1-2.8-4.6-.5-6-1.2-1.6-3.3-2-4.5-1.5z"/>',
  windows: '<path d="M3.5 5.5 10.5 4.5v7h-7zM13 4.2 20.5 3v8.5H13zM3.5 13h7v7l-7-1zM13 13h7.5v8.5L13 20.3z"/>',
  linux: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 15.5h4M7 9l3 2-3 2"/>',
  github: '<path d="M9 19c-4.5 1.5-4.5-2.5-6.5-3m13 6v-3.5a3 3 0 0 0-.9-2.4c3-.3 6.4-1.5 6.4-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.6 12.6 0 0 0-6.6 0C6.6 1.9 5.5 2.2 5.5 2.2a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 4 9.4c0 5.2 3.4 6.4 6.4 6.7a3 3 0 0 0-.9 2.4V22"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  building: '<rect x="4.5" y="3" width="15" height="18" rx="1.5"/><path d="M9 7h1.5M13.5 7H15M9 11h1.5M13.5 11H15M9 15h1.5M13.5 15H15M10 21v-3h4v3"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-5"/>'
};

/** @param {string} name @returns {string} */
function icon(name, className = "icon") {
  if (!ICONS[name]) throw new Error(`unknown docs icon: ${name}`);
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

/** The icon names a rendered page refers to through <use>. */
function iconsUsedIn(html) {
  return [...new Set([...html.matchAll(/href="#icon-([a-z-]+)"/g)].map((match) => match[1]))].sort();
}

/** One hidden sprite with exactly the icons the page uses. */
function iconSprite(names) {
  const unknown = names.filter((name) => !ICONS[name]);
  if (unknown.length > 0) throw new Error(`unknown docs icon: ${unknown.join(", ")}`);
  const symbols = names.map((name) => `<symbol id="icon-${name}" viewBox="0 0 24 24">${ICONS[name]}</symbol>`).join("");
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}</svg>`;
}

export { ICONS, icon, iconSprite, iconsUsedIn };
