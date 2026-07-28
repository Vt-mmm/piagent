import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// Reading documents that live outside the project.
//
// The guard scopes `read`, `grep`, `find`, and `ls` to the project, which is
// right for source: a task that edits this repository has no business reading
// an arbitrary path. It is wrong for the document the task is *about* — a spec
// downloaded to ~/Downloads is input, not source, and blocking it means the
// operator has to copy files into the repository just to be read, which is how
// vendor PDFs end up committed.
//
// The established shape for agent CLIs is to treat read as the permissive axis
// and write as the scoped one: extra directories are granted and then read
// without prompting, while the set of writable roots stays narrow. This follows
// that shape with one extra restriction — inside a granted root only document
// extensions open, so
// granting ~/Downloads does not also hand over an installer or a key file that
// happens to be sitting there.
//
// Everything here is read-only by construction. There is no write path.

export const DOCUMENT_EXTENSIONS = Object.freeze([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "pdf", "docx"
]);

// Large enough for a real specification, small enough that one file cannot
// swallow a context window before the budget check ever sees it.
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 400_000;

export type DocumentRootSource = "project" | "profile" | "environment";

export type DocumentRoot = {
  path: string;
  source: DocumentRootSource;
};

// Device and inode of the file that was checked, so a later open can prove it
// got the same file rather than whatever the name points at by then.
export type DocumentIdentity = { dev: number; ino: number; size: number };

export type DocumentResolution =
  | { status: "ok"; absolutePath: string; extension: string; root: DocumentRoot; identity: DocumentIdentity }
  | { status: "error"; reason: string };

export type DocumentExtraction =
  | { status: "ok"; text: string; truncated: boolean; kind: "text" | "docx" | "pdf" }
  | { status: "error"; reason: string };

export function expandHome(candidate: string, home: string | undefined): string {
  if (candidate === "~") return home ?? candidate;
  if (candidate.startsWith("~/")) {
    if (!home) return candidate;
    return path.join(home, candidate.slice(2));
  }
  return candidate;
}

// A root is only usable when it resolves to a real directory. A missing or
// misspelled root has to disappear rather than match nothing quietly, because a
// silent non-match reads exactly like a correctly denied path.
function canonicalDirectory(candidate: string): string | undefined {
  try {
    const resolved = fs.realpathSync.native(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function parseRootList(value: string | undefined): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function resolveDocumentRoots(options: {
  cwd: string;
  profileRoots?: unknown;
  environmentRoots?: string | undefined;
  home?: string | undefined;
}): DocumentRoot[] {
  const home = options.home ?? os.homedir();
  const roots: DocumentRoot[] = [];
  const seen = new Set<string>();

  const add = (candidate: string, source: DocumentRootSource) => {
    if (typeof candidate !== "string" || candidate.trim().length === 0) return;
    const canonical = canonicalDirectory(path.resolve(expandHome(candidate.trim(), home)));
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    roots.push({ path: canonical, source });
  };

  add(options.cwd, "project");
  if (Array.isArray(options.profileRoots)) {
    for (const item of options.profileRoots) {
      if (typeof item === "string") add(item, "profile");
    }
  }
  for (const item of parseRootList(options.environmentRoots)) add(item, "environment");

  return roots;
}

// Written as a scan rather than a regular expression so the control characters
// it rejects appear as numbers here instead of as invisible bytes in the source.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function containedBy(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function documentExtensionOf(target: string): string | undefined {
  const extension = path.extname(target).toLowerCase().replace(/^\./, "");
  return DOCUMENT_EXTENSIONS.includes(extension) ? extension : undefined;
}

function extensionRefusal(target: string): string {
  const extension = path.extname(target).toLowerCase().replace(/^\./, "");
  return `only document files can be read from outside the project; ${extension ? `.${extension}` : "this path"} is not one of ${DOCUMENT_EXTENSIONS.map((item) => `.${item}`).join(", ")}`;
}

export function resolveDocumentPath(
  rawPath: string,
  roots: DocumentRoot[],
  options: { home?: string; cwd?: string } = {}
): DocumentResolution {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { status: "error", reason: "document path is empty" };
  }
  const trimmed = rawPath.trim();
  if (trimmed.includes("\0")) return { status: "error", reason: "document path contains a null byte" };
  // Refusal messages and the read header quote the path back, and both sit
  // outside the data region. A newline in a filename would write its own line
  // there, at instruction level. The header escapes what it prints as well, but
  // a path carrying control characters has no legitimate caller.
  if (hasControlCharacter(trimmed)) {
    return { status: "error", reason: "document path contains a control character" };
  }

  const expanded = expandHome(trimmed, options.home ?? os.homedir());
  // A relative path means relative to the project. The process working
  // directory is not the project on every host, so it cannot be the anchor.
  const absolute = path.resolve(options.cwd ?? process.cwd(), expanded);
  if (!documentExtensionOf(absolute)) return { status: "error", reason: extensionRefusal(absolute) };

  // Canonicalise before deciding. A symbolic link inside a granted root that
  // points somewhere else must be judged by where it lands, not by where it sits.
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(absolute);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return { status: "error", reason: code === "ENOENT" ? `document does not exist: ${absolute}` : `document cannot be inspected: ${absolute}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    return { status: "error", reason: `document cannot be inspected: ${absolute}` };
  }
  if (!stat.isFile()) return { status: "error", reason: `not a regular file: ${absolute}` };
  if (stat.size <= 0) return { status: "error", reason: `document is empty: ${absolute}` };
  if (stat.size > MAX_DOCUMENT_BYTES) {
    return { status: "error", reason: `document is ${stat.size} bytes, over the ${MAX_DOCUMENT_BYTES} byte limit` };
  }

  const root = roots.find((item) => containedBy(item.path, canonical));
  if (!root) {
    const granted = roots.map((item) => item.path).join(", ") || "none";
    return {
      status: "error",
      reason: `document is outside every readable root (${granted}); add its directory to profile additionalReadRoots or PIAGENT_ADDITIONAL_READ_ROOTS`
    };
  }

  // The extension that decides the outcome is the one on the file that will
  // actually be opened. Judging the requested name instead would let a link
  // called notes.md hand over the key file it points at, since containment is
  // already decided on the target.
  const extension = documentExtensionOf(canonical);
  if (!extension) {
    return {
      status: "error",
      reason: canonical === absolute
        ? extensionRefusal(canonical)
        : `${absolute} resolves to ${canonical}: ${extensionRefusal(canonical)}`
    };
  }

  return {
    status: "ok",
    absolutePath: canonical,
    extension,
    root,
    // Identity of the file every check above was made against. Reading by path
    // afterwards re-resolves the name and can land somewhere else entirely, so
    // the reader has to prove the bytes it opened came from this exact file.
    identity: { dev: stat.dev, ino: stat.ino, size: stat.size }
  };
}

// --- .docx ---------------------------------------------------------------
//
// A .docx is a ZIP holding word/document.xml. Node ships raw inflate but no
// archive reader, so the central directory is walked here rather than pulling
// in a dependency to open a file format that has not changed in fifteen years.
// Every offset read is bounds-checked: this parses a file that arrived from
// outside, so a malformed archive has to produce a message, not a crash.

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_ENTRIES = 4096;

function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  const minimum = Math.max(0, buffer.length - 66_000);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  return undefined;
}

type ZipEntryResult =
  | { status: "ok"; data: Buffer }
  | { status: "error"; reason: string };

// Every refusal names what was actually wrong. "Not a readable .docx" for a
// 4097-entry archive, a corrupt entry, and a file that is not a ZIP at all sends
// the operator looking in three different wrong places.
function malformed(detail: string): ZipEntryResult {
  return { status: "error", reason: `not a readable .docx: ${detail}` };
}

function readZipEntry(buffer: Buffer, entryName: string): ZipEntryResult {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === undefined) return malformed("no ZIP end-of-central-directory record was found");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES) {
    return malformed(`the archive declares ${entryCount} entries, over the ${MAX_ZIP_ENTRIES} entry limit`);
  }

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) return malformed("the central directory runs past the end of the file");
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) return malformed("the central directory is corrupt");

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > buffer.length) return malformed("an entry name runs past the end of the file");
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (name === entryName) {
      if (localOffset + 30 > buffer.length) return malformed(`the ${entryName} entry header runs past the end of the file`);
      if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) return malformed(`the ${entryName} entry header is corrupt`);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataStart > buffer.length || dataEnd > buffer.length) {
        return malformed(`the ${entryName} entry claims more data than the file holds`);
      }
      const data = buffer.subarray(dataStart, dataEnd);
      if (method === 0) return { status: "ok", data: Buffer.from(data) };
      if (method === 8) {
        try {
          return { status: "ok", data: zlib.inflateRawSync(data, { maxOutputLength: MAX_DOCUMENT_BYTES }) };
        } catch {
          return malformed(`${entryName} could not be decompressed; it is corrupt or expands past the ${MAX_DOCUMENT_BYTES} byte limit`);
        }
      }
      return malformed(`${entryName} uses compression method ${method}, which is not supported${method === 99 ? " (the archive is encrypted)" : ""}`);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return malformed(`${entryName} is missing`);
}

// The numeric references here come out of a file that arrived from outside, so
// the value is not trusted to be a code point. String.fromCodePoint throws above
// U+10FFFF, and a surrogate value would leave an unpaired code unit in the
// result, so both are left standing as the text the document actually contains.
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match: string, code: string) => {
      const hex = code[0] === "x" || code[0] === "X";
      const point = hex ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) return match;
      if (point >= 0xd800 && point <= 0xdfff) return match;
      return String.fromCodePoint(point);
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Stripping markup and then decoding entities is the shape of an incomplete
// sanitizer, and static analysis flags it as one: a document containing the
// literal text `&lt;script&gt;` comes out as `<script>`. That is not a defect
// here, it is the required result — the document shows those characters to a
// reader, so extraction has to reproduce them. What makes it safe is the sink.
// This text becomes a Pi tool result, `{ type: "text" }`, rendered in a
// terminal; the shipped package contains no HTML sink at all. Untrusted
// document content is separately redacted and wrapped in a region delimited by
// a marker the document cannot predict. If any renderer that interprets markup
// is ever added downstream, escaping belongs at that boundary, not here, where
// it would corrupt the extracted text for every existing caller.
export function extractDocxText(buffer: Buffer): DocumentExtraction {
  const document = readZipEntry(buffer, "word/document.xml");
  if (document.status === "error") return document;
  // Same rule as a plain text file: decoding leniently would turn undecodable
  // bytes into replacement characters and hand them over as if they were text.
  // OOXML declares UTF-8, so anything else in here is a corrupt or forged part.
  const xml = decodeStrict(document.data, "utf-8");
  if (xml === undefined) {
    return { status: "error", reason: "not a readable .docx: word/document.xml is not valid UTF-8" };
  }
  if (xml.includes("\0")) return { status: "error", reason: "not a readable .docx: word/document.xml holds binary data" };
  const text = xml
    // Paragraph properties declare tab *stops*, and a tab character per declared
    // stop is whitespace the document never showed anybody. The other property
    // blocks hold no text, so the generic tag strip below already handles them.
    .replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, "")
    // Text struck out by a tracked change nobody accepted is not what the
    // document says. Keeping it splices the old value onto the new one, so a
    // price revised from 100 to 200 reads as 100200. Removing the containers
    // rather than the delText run covers the writers that leave a plain w:t
    // inside w:del, and text moved elsewhere is gone from here for the same
    // reason struck-out text is.
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, "")
    // Field instructions are code — MERGEFIELD names, hyperlink targets — and
    // reading them as prose puts markup in front of the model as content.
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return finish(decodeXmlEntities(text), "docx");
}

// --- extraction ----------------------------------------------------------

function finish(text: string, kind: "text" | "docx" | "pdf"): DocumentExtraction {
  if (text.length > MAX_EXTRACTED_CHARS) {
    let cut = text.slice(0, MAX_EXTRACTED_CHARS);
    // slice counts UTF-16 code units, so the cut can land between the two halves
    // of an astral character and leave an unpaired surrogate at the end.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return { status: "ok", text: cut, truncated: true, kind };
  }
  return { status: "ok", text, truncated: false, kind };
}

// UTF-16 is half NUL bytes by design, so the binary check has to know about it
// before it runs, and a byte-order mark is the only signal available without
// guessing. Everything without a mark is treated as UTF-8.
//
// Decoding is strict in both encodings. Buffer.toString substitutes U+FFFD for
// anything it cannot decode, which turns a binary file renamed to .txt into
// "text" made of replacement characters — the exact outcome the extension gate
// exists to prevent. A NUL scan does not catch it either: plenty of binary
// formats carry no NUL in their first bytes.
function decodeStrict(bytes: Buffer, encoding: "utf-8" | "utf-16le"): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeTextBuffer(buffer: Buffer): string | undefined {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
    return undefined;
  }
  const utf16Little = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const utf16Big = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  if (utf16Little || utf16Big) {
    const body = buffer.subarray(2);
    if (body.length % 2 !== 0) return undefined;
    return decodeStrict(utf16Big ? Buffer.from(body).swap16() : body, "utf-16le");
  }
  if (buffer.includes(0)) return undefined;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return decodeStrict(buffer.subarray(3), "utf-8");
  }
  return decodeStrict(buffer, "utf-8");
}

export function extractTextDocument(buffer: Buffer): DocumentExtraction {
  // A text extension is a claim, not a guarantee. Refuse a file whose bytes say
  // otherwise rather than emit replacement characters that read like content.
  const decoded = decodeTextBuffer(buffer);
  if (decoded === undefined) {
    return {
      status: "error",
      reason: "file has a text extension but its bytes are not valid UTF-8 or UTF-16 text; it is binary or in some other encoding"
    };
  }
  return finish(decoded.replace(/\r\n?/g, "\n"), "text");
}

// PDF text extraction needs a real parser. Node has none, and writing one is
// not a side quest worth taking, so this delegates to pdftotext when the host
// has it and says so plainly when it does not. Reporting "no text found" for a
// missing tool would be a lie in the direction that wastes the most time.
export function extractPdfFromDescriptor(
  fd: number,
  run: (command: string, args: string[], input?: number) => { status: number | null; stdout: string; stderr: string; error?: Error } = defaultRun
): DocumentExtraction {
  const probe = run("command", ["-v", "pdftotext"]);
  if (probe.error || probe.status !== 0) {
    return {
      status: "error",
      reason: "reading .pdf needs pdftotext, which is not on PATH; install poppler (macOS: brew install poppler, Debian/Ubuntu: apt install poppler-utils) or convert the file to .txt"
    };
  }
  // `-layout` keeps table columns readable, and the two `-` are stdin in and
  // stdout out. The converter is handed the already-open descriptor rather than
  // a path, so it reads the file whose identity was verified and cannot be
  // pointed somewhere else by a name that changed in the meantime.
  const result = run("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], fd);
  if (result.error) {
    return {
      status: "error",
      reason: /ETIMEDOUT/.test(result.error.message)
        ? `pdftotext did not finish within ${PDF_TIMEOUT_MS / 1000}s on this file and was stopped`
        : `pdftotext failed: ${result.error.message}`
    };
  }
  if (result.status !== 0) {
    return { status: "error", reason: `pdftotext exited ${result.status}: ${result.stderr.trim().slice(0, 300) || "no output"}` };
  }
  const text = result.stdout.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length === 0) {
    return { status: "error", reason: "pdftotext produced no text; the PDF is probably scanned images and needs OCR" };
  }
  return finish(text, "pdf");
}

// spawnSync blocks the whole runtime, so an external converter that never
// returns would hang the session rather than fail the read.
const PDF_TIMEOUT_MS = 20_000;

function defaultRun(
  command: string,
  args: string[],
  input?: number
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = command === "command"
    ? spawnSync("/bin/sh", ["-c", `command -v ${args[1]}`], { encoding: "utf8", timeout: PDF_TIMEOUT_MS })
    : spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_DOCUMENT_BYTES,
      timeout: PDF_TIMEOUT_MS,
      stdio: [input ?? "ignore", "pipe", "pipe"]
    });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

// --- reading -------------------------------------------------------------
//
// Everything resolveDocumentPath decided — containment in a granted root, the
// extension, the size limit, and the guard's protected-path check on top of it
// — was decided about one specific file. Re-opening by path afterwards resolves
// the name again, and a name can point somewhere else by then: replacing the
// checked file with a symbolic link between the check and the read returned the
// contents of a file outside every granted root. So the file is opened once and
// the descriptor is what gets read, after proving it is the same file.
//
// Identity is device plus inode plus size. An attacker who deletes and recreates
// the file cannot choose which inode they get, so a match means the descriptor
// refers to the file that passed the checks.

export type ResolvedDocument = Extract<DocumentResolution, { status: "ok" }>;

const DOCUMENT_CHANGED = "document changed between the safety checks and the read, so nothing was read";

// Opening blocks until a writer appears when the name has become a FIFO, and the
// identity check below never runs — the read hangs instead of being refused.
// O_NONBLOCK returns a descriptor immediately for any file type, and has no
// effect on reads from a regular file, which is the only type that gets past the
// check. O_NOFOLLOW refuses a symbolic link at the final component: the path was
// already canonicalised, so a link there means the name was swapped after it was
// checked, which is the substitution this open exists to defeat.
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

function openVerifiedDocument(
  resolution: ResolvedDocument
): { status: "ok"; fd: number; size: number } | { status: "error"; reason: string } {
  let fd: number;
  try {
    fd = fs.openSync(resolution.absolutePath, OPEN_FLAGS);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ELOOP") return { status: "error", reason: DOCUMENT_CHANGED };
    return {
      status: "error",
      reason: code === "ENOENT"
        ? `document does not exist: ${resolution.absolutePath}`
        : `document cannot be opened: ${resolution.absolutePath}`
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    fs.closeSync(fd);
    return { status: "error", reason: `document cannot be inspected: ${resolution.absolutePath}` };
  }
  const { dev, ino, size } = resolution.identity;
  if (!stat.isFile() || stat.dev !== dev || stat.ino !== ino || stat.size !== size) {
    fs.closeSync(fd);
    return { status: "error", reason: DOCUMENT_CHANGED };
  }
  return { status: "ok", fd, size: stat.size };
}

function readAllFromDescriptor(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buffer, offset, size - offset, offset);
    if (read <= 0) break;
    offset += read;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

export function extractDocument(
  resolution: ResolvedDocument,
  options: { extractPdf?: (fd: number) => DocumentExtraction } = {}
): DocumentExtraction {
  const opened = openVerifiedDocument(resolution);
  if (opened.status === "error") return opened;
  try {
    if (resolution.extension === "pdf") {
      return (options.extractPdf ?? ((fd: number) => extractPdfFromDescriptor(fd)))(opened.fd);
    }
    const buffer = readAllFromDescriptor(opened.fd, opened.size);
    if (resolution.extension === "docx") return extractDocxText(buffer);
    return extractTextDocument(buffer);
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      // The read already produced its result; a failing close cannot change it.
    }
  }
}
