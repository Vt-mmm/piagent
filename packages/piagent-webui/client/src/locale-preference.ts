// The locale union lives here, not in the component module, so this file has
// no dependency on JSX and the repository typecheck can read it.
export type UiLocale = "vi" | "en";

// The language the browser asked for, when the reader has not chosen one here.
//
// Colour mode has always followed `prefers-color-scheme`; the language followed
// nothing and simply started in Vietnamese. A reader outside Vietnam opened a
// Vietnamese interface and had to find the toggle before they could read it,
// which is the wrong way round for the one setting the browser already states.
//
// This lives in its own `.ts` file rather than beside the context in
// `ui-preferences.tsx` because the repository's TypeScript loader resolves `.ts`
// and not `.tsx`, so anything inside a component file cannot be imported by a
// test. Pure logic belongs outside the component regardless.
export function preferredLocale(languages: readonly string[] | undefined): UiLocale {
  for (const tag of languages ?? []) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base === "vi") return "vi";
    if (base) return "en";
  }
  return "en";
}
