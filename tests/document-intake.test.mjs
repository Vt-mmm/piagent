import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, describe, it } from "node:test";

import {
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
  MAX_EXTRACTED_CHARS,
  extractDocument,
  extractDocxText,
  extractPdfWithPdftotext,
  extractTextDocument,
  parseRootList,
  resolveDocumentPath,
  resolveDocumentRoots
} from "../packages/piagent-core/extensions/document-intake.ts";

const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-doc-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-doc-")));
  temporaryRoots.add(root);
  return root;
}

function write(root, name, contents) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

// ZIP archives written by hand, so the archive reader is tested against bytes
// this repository controls rather than against whatever a word processor happens
// to emit on the machine running the suite. Multi-entry archives matter as much
// as single-entry ones: with one entry the central-directory walk never advances,
// so the arithmetic that finds the second entry is never executed.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.contents, "utf8");
    const method = entry.method ?? (entry.compressed ? 8 : 0);
    const data = entry.compressed ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);

    // Real writers put extra fields and comments in central-directory entries.
    // Without them a reader that ignores those lengths still finds every entry,
    // so the fixture has to carry them for the walk to mean anything.
    const extra = Buffer.alloc(entry.extraLength ?? 0, 0x00);
    const comment = Buffer.from(entry.comment ?? "", "utf8");

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name, extra, comment);
    offset += local.length + name.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, end]);
}

function buildDocx(documentXml, compressed, entryName = "word/document.xml") {
  return buildZip([{ name: entryName, contents: documentXml, compressed }]);
}

// The end-of-central-directory record is the last 22 bytes.
function patchEndOfCentralDirectory(buffer, field, value) {
  const patched = Buffer.from(buffer);
  const eocd = patched.length - 22;
  if (field === "entryCount") {
    patched.writeUInt16LE(value, eocd + 8);
    patched.writeUInt16LE(value, eocd + 10);
  } else {
    patched.writeUInt32LE(value, eocd + 16);
  }
  return patched;
}

function paragraph(inner) {
  return `<w:p>${inner}</w:p>`;
}

function rootsFor(...directories) {
  return directories.map((directory, index) => ({
    path: directory,
    source: index === 0 ? "project" : "profile"
  }));
}

describe("document read roots", () => {
  it("keeps the project root and drops directories that do not exist", () => {
    const project = temporaryDirectory();
    const granted = temporaryDirectory();
    const roots = resolveDocumentRoots({
      cwd: project,
      profileRoots: [granted, path.join(granted, "not-there")],
      environmentRoots: undefined
    });
    assert.deepEqual(roots.map((item) => item.path), [project, granted]);
    assert.deepEqual(roots.map((item) => item.source), ["project", "profile"]);
  });

  // A misspelled root that silently matches nothing is indistinguishable from a
  // correctly denied path, which sends the operator looking in the wrong place.
  it("drops a root that points at a file rather than a directory", () => {
    const project = temporaryDirectory();
    const notADirectory = write(project, "notes.md", "x\n");
    const roots = resolveDocumentRoots({ cwd: project, profileRoots: [notADirectory] });
    assert.deepEqual(roots.map((item) => item.path), [project]);
  });

  it("reads environment roots as a path list and records where each root came from", () => {
    const project = temporaryDirectory();
    const fromEnvironment = temporaryDirectory();
    assert.deepEqual(parseRootList(`a${path.delimiter} b ${path.delimiter}`), ["a", "b"]);
    const roots = resolveDocumentRoots({ cwd: project, environmentRoots: fromEnvironment });
    assert.equal(roots.at(-1).source, "environment");
    assert.equal(roots.at(-1).path, fromEnvironment);
  });

  it("expands a home-relative root", () => {
    const project = temporaryDirectory();
    const home = temporaryDirectory();
    fs.mkdirSync(path.join(home, "Downloads"));
    const roots = resolveDocumentRoots({ cwd: project, profileRoots: ["~/Downloads"], home });
    assert.deepEqual(roots.map((item) => item.path), [project, path.join(home, "Downloads")]);
  });
});

describe("document path resolution", () => {
  it("accepts a document inside a granted root", () => {
    const project = temporaryDirectory();
    const granted = temporaryDirectory();
    const target = write(granted, "spec.md", "# Spec\n");
    const resolved = resolveDocumentPath(target, rootsFor(project, granted));
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.absolutePath, target);
    assert.equal(resolved.extension, "md");
    assert.equal(resolved.root.path, granted);
  });

  // The point of the extension filter: granting a folder must not hand over
  // whatever else happens to be sitting in it.
  it("refuses a non-document file inside a granted root", () => {
    const project = temporaryDirectory();
    const granted = temporaryDirectory();
    const target = write(granted, "id_rsa", "PRIVATE KEY\n");
    const resolved = resolveDocumentPath(target, rootsFor(project, granted));
    assert.equal(resolved.status, "error");
    assert.match(resolved.reason, /only document files/);
  });

  it("refuses a document outside every granted root and names the grants", () => {
    const project = temporaryDirectory();
    const elsewhere = temporaryDirectory();
    const target = write(elsewhere, "spec.md", "# Spec\n");
    const resolved = resolveDocumentPath(target, rootsFor(project));
    assert.equal(resolved.status, "error");
    assert.match(resolved.reason, /outside every readable root/);
    assert.match(resolved.reason, /additionalReadRoots/);
  });

  // A link is judged by where it lands. Otherwise a granted folder becomes a
  // doorway to every file the user can read.
  it("judges a symbolic link by its target, not its location", () => {
    const project = temporaryDirectory();
    const granted = temporaryDirectory();
    const outside = temporaryDirectory();
    const real = write(outside, "secret.md", "# Secret\n");
    const link = path.join(granted, "innocent.md");
    fs.symlinkSync(real, link);

    const escaping = resolveDocumentPath(link, rootsFor(project, granted));
    assert.equal(escaping.status, "error", "a link out of the granted root must not resolve");
    assert.match(escaping.reason, /outside every readable root/);

    const contained = resolveDocumentPath(link, rootsFor(project, granted, outside));
    assert.equal(contained.status, "ok", "the same link resolves once its target is granted");
    assert.equal(contained.absolutePath, real);
  });

  it("refuses a directory, a missing file, an empty file, and a null byte", () => {
    const project = temporaryDirectory();
    fs.mkdirSync(path.join(project, "docs.md"));
    write(project, "blank.md", "");
    for (const [candidate, pattern] of [
      [path.join(project, "docs.md"), /not a regular file/],
      [path.join(project, "gone.md"), /does not exist/],
      [path.join(project, "blank.md"), /is empty/],
      ["spec\0.md", /null byte/],
      ["   ", /is empty/]
    ]) {
      const resolved = resolveDocumentPath(candidate, rootsFor(project));
      assert.equal(resolved.status, "error", `${candidate} should be refused`);
      assert.match(resolved.reason, pattern);
    }
  });

  it("refuses a document over the byte limit", () => {
    const project = temporaryDirectory();
    const target = path.join(project, "huge.txt");
    fs.writeFileSync(target, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61));
    const resolved = resolveDocumentPath(target, rootsFor(project));
    assert.equal(resolved.status, "error");
    assert.match(resolved.reason, /over the .* byte limit/);
  });

  it("covers every advertised extension", () => {
    const project = temporaryDirectory();
    for (const extension of DOCUMENT_EXTENSIONS) {
      const target = write(project, `sample.${extension}`, "x\n");
      const resolved = resolveDocumentPath(target, rootsFor(project));
      assert.equal(resolved.status, "ok", `.${extension} is advertised but refused`);
    }
  });

  it("matches an extension whatever case it is written in", () => {
    const project = temporaryDirectory();
    const target = write(project, "SPEC.MD", "# Spec\n");
    const resolved = resolveDocumentPath(target, rootsFor(project));
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.extension, "md");
  });

  // The extension filter is the second gate, and it has to judge the file that
  // will be opened. A link named notes.md pointing at a key file passes
  // containment, because containment is decided on the target.
  it("refuses a link inside a granted root that lands on a non-document file", () => {
    const project = temporaryDirectory();
    const granted = temporaryDirectory();
    const key = write(granted, "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    fs.symlinkSync(key, path.join(granted, "notes.md"));

    const resolved = resolveDocumentPath(path.join(granted, "notes.md"), rootsFor(project, granted));
    assert.equal(resolved.status, "error");
    assert.match(resolved.reason, /only document files/);
    assert.match(resolved.reason, /resolves to/);
  });

  // A root is a directory, not a string prefix.
  it("does not treat a sibling directory sharing a name prefix as inside the root", () => {
    const parent = temporaryDirectory();
    const granted = path.join(parent, "docs");
    const sibling = path.join(parent, "docs-secret");
    fs.mkdirSync(granted);
    fs.mkdirSync(sibling);
    const target = write(sibling, "leak.md", "# Secret\n");

    const resolved = resolveDocumentPath(target, [{ path: granted, source: "profile" }]);
    assert.equal(resolved.status, "error");
    assert.match(resolved.reason, /outside every readable root/);
  });

  // A relative path means relative to the project. The process working
  // directory is not the project on every host.
  it("anchors a relative path on the supplied project directory", () => {
    const project = temporaryDirectory();
    const target = write(project, "spec.md", "# Spec\n");

    const anchored = resolveDocumentPath("spec.md", rootsFor(project), { cwd: project });
    assert.equal(anchored.status, "ok");
    assert.equal(anchored.absolutePath, target);

    const unanchored = resolveDocumentPath("spec.md", rootsFor(project), { cwd: os.tmpdir() });
    assert.equal(unanchored.status, "error", "the same name must not resolve from a different directory");
  });
});

describe("document read root selection", () => {
  it("de-duplicates roots and keeps the first grant that contains the document", () => {
    const project = temporaryDirectory();
    const granted = temporaryDirectory();
    const nested = path.join(granted, "specs");
    fs.mkdirSync(nested);
    const target = write(nested, "spec.md", "# Spec\n");

    const roots = resolveDocumentRoots({
      cwd: project,
      profileRoots: [granted, granted, nested],
      environmentRoots: granted
    });
    assert.deepEqual(roots.map((item) => item.path), [project, granted, nested]);

    const resolved = resolveDocumentPath(target, roots);
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.root.path, granted, "the first containing root wins, so the reported grant is stable");
  });
});

describe("document extraction", () => {
  it("reads text and normalises line endings", () => {
    const extracted = extractTextDocument(Buffer.from("one\r\ntwo\r\n"));
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.text, "one\ntwo\n");
    assert.equal(extracted.kind, "text");
  });

  // A text extension is a claim about the bytes, not a guarantee. Emitting
  // replacement characters would read like content the model can reason about.
  it("refuses binary content wearing a text extension", () => {
    const extracted = extractTextDocument(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41]));
    assert.equal(extracted.status, "error");
    assert.match(extracted.reason, /binary/);
  });

  // A NUL scan only catches the binaries that happen to carry a NUL early.
  // Decoding leniently turns everything else into replacement characters, which
  // is content-shaped garbage handed to the model — the outcome the extension
  // gate exists to prevent.
  it("refuses bytes that are not valid UTF-8 rather than substituting replacement characters", () => {
    for (const bytes of [
      [0xc3, 0x28], // a lead byte followed by an invalid continuation
      [0xe2, 0x82], // a three-byte sequence cut short
      [0xa0, 0xa1], // continuation bytes with no lead
      [0xf8, 0x88, 0x80, 0x80, 0x80], // five-byte sequence, never legal
      [0xed, 0xa0, 0x80] // a surrogate half encoded as UTF-8
    ]) {
      const extracted = extractTextDocument(Buffer.from(bytes));
      assert.equal(extracted.status, "error", `${bytes.map((b) => b.toString(16)).join(" ")} should be refused`);
      assert.doesNotMatch(extracted.reason ?? "", /�/);
    }

    const valid = extractTextDocument(Buffer.from("xin chào — ok\n"));
    assert.equal(valid.status, "ok");
    assert.equal(valid.text, "xin chào — ok\n");
  });

  it("refuses byte-order-marked text whose body is not valid in that encoding", () => {
    const badUtf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x00, 0xd8, 0x41, 0x00])]);
    assert.equal(extractTextDocument(badUtf16).status, "error");

    const badUtf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xc3, 0x28])]);
    assert.equal(extractTextDocument(badUtf8Bom).status, "error");
  });

  it("truncates rather than returning an unbounded string", () => {
    const extracted = extractTextDocument(Buffer.from("a".repeat(MAX_EXTRACTED_CHARS + 100)));
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.truncated, true);
    assert.equal(extracted.text.length, MAX_EXTRACTED_CHARS);
  });

  // The limit counts UTF-16 code units, so a cut can land between the halves of
  // an astral character and leave an unpaired surrogate at the end.
  it("does not end a truncated document on half a character", () => {
    const extracted = extractTextDocument(Buffer.from(`${"a".repeat(MAX_EXTRACTED_CHARS - 1)}\u{1F600}`));
    assert.equal(extracted.truncated, true);
    assert.equal(extracted.text.length, MAX_EXTRACTED_CHARS - 1);
    assert.equal(extracted.text.at(-1), "a");
    assert.equal(extracted.text, JSON.parse(JSON.stringify(extracted.text)), "the text must survive a round trip through JSON");
  });

  // UTF-16 is half NUL bytes by design, so the binary check has to recognise it
  // rather than report a perfectly readable file as binary.
  it("decodes byte-order-marked text and still refuses real binary", () => {
    const utf16Little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("xin chào\n", "utf16le")]);
    assert.equal(extractTextDocument(utf16Little).text, "xin chào\n");

    const utf16Big = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from("xin chào\n", "utf16le")).swap16()]);
    assert.equal(extractTextDocument(utf16Big).text, "xin chào\n");

    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Spec\n")]);
    assert.equal(extractTextDocument(utf8Bom).text, "# Spec\n");

    const utf32 = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), Buffer.alloc(8)]);
    assert.equal(extractTextDocument(utf32).status, "error");
  });

  // The archive reader is the riskiest code in this module, so it is exercised
  // against a well-formed archive and not only against rejections. Both storage
  // methods are covered: real writers use deflate, but stored entries are legal
  // and a reader that only handles one of them fails on a file nobody expects.
  it("reads paragraphs, tabs, breaks, and entities out of a docx", () => {
    const xml = "<w:document><w:body>"
      + "<w:p><w:r><w:t>Spec &amp; scope</w:t></w:r></w:p>"
      + "<w:p><w:r><w:t>Step 1</w:t><w:tab/><w:t>xác thực</w:t><w:br/><w:t>Step 2</w:t></w:r></w:p>"
      + "</w:body></w:document>";
    for (const compressed of [false, true]) {
      const extracted = extractDocxText(buildDocx(xml, compressed));
      assert.equal(extracted.status, "ok", `${compressed ? "deflated" : "stored"} archive should read`);
      assert.equal(extracted.kind, "docx");
      assert.equal(extracted.text, "Spec & scope\nStep 1\txác thực\nStep 2");
    }
  });

  it("refuses a zip that is well formed but is not a docx", () => {
    const extracted = extractDocxText(buildDocx("<x/>", true, "other/thing.xml"));
    assert.equal(extracted.status, "error");
    assert.match(extracted.reason, /word\/document\.xml/);
  });

  // With one entry the central-directory walk never advances, so the arithmetic
  // that steps past an entry is only executed by an archive that has several —
  // which is every archive a word processor actually writes.
  it("finds word/document.xml past earlier entries in a multi-entry archive", () => {
    const buffer = buildZip([
      { name: "[Content_Types].xml", contents: "<Types/>", compressed: true, extraLength: 12 },
      { name: "_rels/.rels", contents: "<Relationships/>", compressed: false, comment: "written by a real word processor" },
      { name: "word/document.xml", contents: paragraph("<w:r><w:t>Third entry</w:t></w:r>"), compressed: true },
      { name: "word/styles.xml", contents: "<w:styles/>", compressed: true }
    ]);
    const extracted = extractDocxText(buffer);
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.text, "Third entry");
  });

  // Each refusal names what was wrong. One message for every malformed shape
  // sends the operator looking in the wrong place.
  it("names the specific defect in a malformed archive", () => {
    const valid = buildZip([{ name: "word/document.xml", contents: paragraph("<w:t>ok</w:t>"), compressed: true }]);

    const overEntryLimit = patchEndOfCentralDirectory(valid, "entryCount", 5000);
    assert.match(extractDocxText(overEntryLimit).reason, /over the \d+ entry limit/);

    const pastEnd = patchEndOfCentralDirectory(valid, "centralOffset", valid.length - 10);
    assert.match(extractDocxText(pastEnd).reason, /past the end of the file/);

    const badSignature = patchEndOfCentralDirectory(valid, "centralOffset", 4);
    assert.match(extractDocxText(badSignature).reason, /central directory is corrupt/);

    const encrypted = buildZip([{ name: "word/document.xml", contents: "<w:t>x</w:t>", method: 99 }]);
    assert.match(extractDocxText(encrypted).reason, /compression method 99/);

    // The deflate stream starts after the 30-byte local header and the name.
    const corruptDeflate = Buffer.from(valid);
    corruptDeflate.writeUInt32LE(0xdeadbeef, 30 + Buffer.byteLength("word/document.xml"));
    assert.match(extractDocxText(corruptDeflate).reason, /could not be decompressed/);
  });

  // The file arrived from outside, so a numeric reference is an attacker-chosen
  // integer, not a promise that a code point exists at that value.
  it("leaves an out-of-range character reference alone instead of throwing", () => {
    for (const reference of ["&#1114112;", "&#99999999999999999999;", "&#55296;"]) {
      const extracted = extractDocxText(buildDocx(paragraph(`<w:t>a${reference}b</w:t>`), true));
      assert.equal(extracted.status, "ok", `${reference} should not end the read`);
      assert.equal(extracted.text, `a${reference}b`);
    }
  });

  it("decodes decimal and hexadecimal character references", () => {
    const extracted = extractDocxText(buildDocx(paragraph("<w:t>&#65;&#x42;&#x1F600;</w:t>"), true));
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.text, "AB\u{1F600}");
  });

  // An unaccepted tracked change is not what the document says. Keeping the
  // struck-out run splices the old value onto the new one.
  it("drops tracked-change deletions, field codes, and tab-stop declarations", () => {
    // The paragraph carrying the tab stops is second, so a tab leaking out of a
    // property block lands inside the string rather than at the front where
    // trimming would hide it.
    const xml = paragraph("<w:r><w:t>Quote</w:t></w:r>")
      + paragraph(
        "<w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"720\"/><w:tab w:val=\"left\" w:pos=\"1440\"/></w:tabs></w:pPr>"
        + "<w:r><w:t>Price is </w:t></w:r>"
        + "<w:del w:id=\"1\" w:author=\"a\"><w:r><w:delText>100</w:delText></w:r></w:del>"
        + "<w:ins w:id=\"2\" w:author=\"a\"><w:r><w:t>200</w:t></w:r></w:ins>"
        + "<w:r><w:instrText> MERGEFIELD Total </w:instrText></w:r>"
      );
    const extracted = extractDocxText(buildDocx(xml, true));
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.text, "Quote\nPrice is 200");
  });

  // Not every writer marks struck-out text with w:delText, and text moved away
  // is gone from here for the same reason struck-out text is.
  it("drops a deletion holding a plain run, and text moved elsewhere", () => {
    const xml = paragraph(
      "<w:r><w:t>Ship on </w:t></w:r>"
      + "<w:del w:id=\"3\"><w:r><w:t>Monday</w:t></w:r></w:del>"
      + "<w:moveFrom w:id=\"4\"><w:r><w:t>, maybe</w:t></w:r></w:moveFrom>"
      + "<w:r><w:t>Friday</w:t></w:r>"
    );
    const extracted = extractDocxText(buildDocx(xml, true));
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.text, "Ship on Friday");
  });

  it("refuses a docx whose document.xml holds binary data", () => {
    const extracted = extractDocxText(buildDocx("<w:t>a\0b</w:t>", true));
    assert.equal(extracted.status, "error");
    assert.match(extracted.reason, /binary/);
  });

  // This parses an archive that arrived from outside, so every malformed shape
  // has to produce a message rather than an exception.
  it("refuses malformed docx archives without throwing", () => {
    for (const buffer of [
      Buffer.alloc(0),
      Buffer.from("not a zip at all"),
      Buffer.from("PK" + " ".repeat(80)),
      Buffer.alloc(64, 0xff)
    ]) {
      const extracted = extractDocxText(buffer);
      assert.equal(extracted.status, "error");
      assert.match(extracted.reason, /not a readable \.docx/);
    }
  });

  it("reports a missing pdftotext as a missing tool, not as an empty document", () => {
    const extracted = extractPdfWithPdftotext("/tmp/whatever.pdf", () => ({ status: 1, stdout: "", stderr: "" }));
    assert.equal(extracted.status, "error");
    assert.match(extracted.reason, /pdftotext/);
    assert.match(extracted.reason, /brew install poppler/);
  });

  it("reports a converter that fails or never returns rather than reporting no text", () => {
    const timedOut = extractPdfWithPdftotext("/tmp/slow.pdf", (command) => (
      command === "command"
        ? { status: 0, stdout: "/usr/bin/pdftotext", stderr: "" }
        : { status: null, stdout: "", stderr: "", error: new Error("spawnSync pdftotext ETIMEDOUT") }
    ));
    assert.equal(timedOut.status, "error");
    assert.match(timedOut.reason, /did not finish within/);

    const failed = extractPdfWithPdftotext("/tmp/broken.pdf", (command) => (
      command === "command"
        ? { status: 0, stdout: "/usr/bin/pdftotext", stderr: "" }
        : { status: 1, stdout: "", stderr: "Syntax Error: Couldn't find trailer dictionary" }
    ));
    assert.equal(failed.status, "error");
    assert.match(failed.reason, /exited 1/);
    assert.match(failed.reason, /trailer dictionary/);
  });

  it("returns converted pdf text when the converter succeeds", () => {
    const extracted = extractPdfWithPdftotext("/tmp/spec.pdf", (command) => (
      command === "command"
        ? { status: 0, stdout: "/usr/bin/pdftotext", stderr: "" }
        : { status: 0, stdout: "Title\r\n\r\n\r\n\r\nBody\r\n", stderr: "" }
    ));
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.kind, "pdf");
    assert.equal(extracted.text, "Title\n\nBody");
  });

  it("reports a scanned pdf as needing OCR rather than as success", () => {
    const extracted = extractPdfWithPdftotext("/tmp/scan.pdf", (command) => (
      command === "command" ? { status: 0, stdout: "/usr/bin/pdftotext", stderr: "" } : { status: 0, stdout: "  \n\n ", stderr: "" }
    ));
    assert.equal(extracted.status, "error");
    assert.match(extracted.reason, /OCR/);
  });

  it("dispatches by extension and reports read failures", () => {
    const project = temporaryDirectory();
    const target = write(project, "notes.md", "hello\n");
    assert.equal(extractDocument(target, "md").kind, "text");
    assert.equal(extractDocument(path.join(project, "gone.md"), "md").status, "error");
    assert.equal(
      extractDocument("/tmp/x.pdf", "pdf", { extractPdf: () => ({ status: "ok", text: "pdf text", truncated: false, kind: "pdf" }) }).text,
      "pdf text"
    );

    // The docx branch has to be reached through the dispatcher, not only by
    // calling the extractor directly.
    const docx = write(project, "spec.docx", buildDocx(paragraph("<w:t>From dispatch</w:t>"), true));
    const fromDispatch = extractDocument(docx, "docx");
    assert.equal(fromDispatch.kind, "docx");
    assert.equal(fromDispatch.text, "From dispatch");
  });
});
