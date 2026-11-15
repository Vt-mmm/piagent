// What a reviewer reads of each changed file (owner, 2026-11-15). A review of
// a usage guide with 176 step screenshots ran in 72 parts and 25M tokens: the
// patch is taken with `git diff --binary` (its digest must see every byte),
// so each image arrived as pages of encoded bytes no reviewer can judge, and
// a generated 4,278-line shots.json filled parts of its own. The digest still
// covers every byte; only what the reviewer reads shrinks:
// - a binary file (an image, a font, an archive) is one line naming it;
// - a generated file (a lockfile, a build output, a minified or map file, a
//   file marked @generated) is one line: its producer is what to review;
// - a data file (json, csv, yaml…) with more than DATA_LINES changed lines
//   is one line: the code that reads it is reviewed, and the reviewer may
//   open a part of it when the code depends on its shape.
// Screenshots the change adds are checked through the code that uses them
// (each referenced file exists, each new image is used), and the reviewer
// may open up to REVIEW_IMAGE_READS of them to look (helper-run.mjs).
export const DATA_LINES = 1500, REVIEW_IMAGE_READS = 6;
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|Podfile\.lock|packages\.lock\.json)$|(^|\/)(dist|build|out|coverage|\.next|\.nuxt|__snapshots__)\/|\.(min\.(js|css)|map|snap)$/i;
const DATA = /\.(json|jsonl|ndjson|csv|tsv|ya?ml|xml|txt)$/i;
export const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|avif|ico)$/i;

const changedLines = (text, kind) => kind === 'new' ? text.split('\n').length - 1
  : text.split('\n').filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')).length;
const how = text => /^new file mode/m.test(text) ? 'added' : /^deleted file mode/m.test(text) ? 'deleted' : 'changed';

// The text a reviewer reads for one section of the patch (`kind`: diff or new).
export function slimSection(file, text, kind = 'diff') {
  if (kind === 'diff' && (/^GIT binary patch$/m.test(text) || /^Binary files .* differ$/m.test(text)))
    return `=== binary file ${file} ${how(text)}: listed, not read.${IMAGE.test(file) ? ' Check it through the code that uses it; open it only when what it shows matters to the change.' : ''}\n`;
  const lines = changedLines(text, kind), marked = /@generated\b/.test(text.slice(0, 2000));
  if (GENERATED.test(file) || marked) return `=== ${file}: generated file, ${lines} lines changed: not read line by line; review what produces it.\n`;
  if (DATA.test(file) && lines > DATA_LINES) return `=== ${file}: data file, ${lines} lines changed: not read line by line; read a part only when the code depends on its shape.\n`;
  return text;
}

// A whole `git diff` with each file's section slimmed.
export function slimPatch(patch) {
  return String(patch ?? '').split(/(?=^diff --git )/m).filter(Boolean).map(text => {
    const file = /^diff --git (?:"?a\/(.+?)"? )"?b\/(.+?)"?$/m.exec(text)?.[2];
    return file ? slimSection(file, text, 'diff') : text;
  }).join('');
}
