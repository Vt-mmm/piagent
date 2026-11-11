// Which repositories of a folder a team memory round or question is about
// (memory.mjs). `repos` are the folder's repositories ({ key, name, dir }),
// `recent` the keys this conversation changed or named, most recent last.

// When the folder holds several: those the text names (by folder or
// repository name, "Vector Center" as well as "vector-center"), else all of
// them when they are few (a front and a back end). In a folder of many, the
// one this conversation worked in last, else none: taking the first few by
// name filed rounds and searches under repositories they were not about.
export function aboutRepos(repos = [], recent = [], text, max) {
  if (repos.length <= 1) return repos;
  const named = namedRepos(repos, text);
  if (named.length) return named.slice(0, max);
  if (repos.length <= max) return repos;
  const last = repos.find(r => r.key === recent.at(-1));
  return last ? [last] : [];
}
export function namedRepos(repos = [], text) {
  const words = s => ` ${String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const t = words(text);
  return repos.filter(r => [r.name, r.key.split('/').at(-1)].some(n => n && words(n).trim() && t.includes(words(n))));
}
// `recent` with these repositories moved to its end.
export const workedRepos = (recent = [], repos = []) => [...recent.filter(k => !repos.some(r => r.key === k)), ...repos.map(r => r.key)];
// A folder of many repositories and a question that names none of them.
export const unnamedText = (repos = []) => `This folder holds several repositories and the question names none of them; pass repository (one of: ${repos.map(r => r.name || r.key).join(', ')}).`;
export function pickRepo(repos = [], repository) {
  if (!repository) return null;
  const want = String(repository).toLowerCase().replace(/\/+$/, '');
  return repos.find(r => r.name.toLowerCase() === want || r.key === want || r.key.split('/').at(-1) === want) ?? null;
}
