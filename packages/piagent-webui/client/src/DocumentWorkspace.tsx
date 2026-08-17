import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import InputAdornment from "@mui/material/InputAdornment";
import ListItemButton from "@mui/material/ListItemButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DescriptionRounded from "@mui/icons-material/DescriptionRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";

import type { Document as DocumentContent, Entry, Listing, Root } from "../../contracts/generated/document-workspace-v1.ts";
import { readDocument, readDocumentIndex } from "./api.ts";
import { label } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

// The markdown renderer pulls in a large parser. The transcript already loads it
// on demand, and importing it eagerly here would fold it back into the main
// chunk for everyone — including the operators who never open this workspace.
const MarkdownMessage = lazy(async () => ({ default: (await import("./MarkdownMessage.tsx")).MarkdownMessage }));

type LoadState<T> = { state: "idle" | "loading" | "ready" | "error"; value?: T };

const MARKDOWN = new Set(["md", "markdown"]);
const TABULAR = new Set(["csv", "tsv"]);

function formatSize(value: number): string {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function rootLabel(root: Root, locale: UiLocale): string {
  if (root.source === "project") return localize(locale, "Project", "Project");
  return localize(locale, "Thư mục đã cấp quyền", "Granted directory");
}

// Bounded RFC-4180 parsing keeps quoted delimiters, escaped quotes and multiline
// fields intact without letting a wide file allocate an unbounded cell matrix.
function parseTable(text: string, separator: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false, index = 0;
  const pushField = () => { if (row.length < 40) row.push(field); field = ""; };
  const pushRow = () => { pushField(); if (row.some((cell) => cell.length > 0)) rows.push(row); row = []; };
  while (index < text.length && rows.length < 500) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 2; continue; }
      if (character === '"') { quoted = false; index += 1; continue; }
      field += character; index += 1; continue;
    }
    if (character === '"' && field.length === 0) { quoted = true; index += 1; continue; }
    if (character === separator) { pushField(); index += 1; continue; }
    if (character === "\n" || character === "\r") {
      pushRow(); if (character === "\r" && text[index + 1] === "\n") index += 1; index += 1; continue;
    }
    field += character; index += 1;
  }
  if (rows.length < 500 && (field.length > 0 || row.length > 0)) pushRow();
  return rows;
}

function TabularPreview({ text, separator }: { text: string; separator: string }) {
  const rows = useMemo(() => parseTable(text, separator), [text, separator]);
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  const columns = Math.min(Math.max(...rows.map((row) => row.length)), 40);
  return <Box sx={{ overflowX: "auto" }}>
    <Box component="table" className="document-table">
      <Box component="thead"><Box component="tr">{Array.from({ length: columns }, (_, index) =>
        <Box component="th" key={index}>{header[index] ?? ""}</Box>)}</Box></Box>
      <Box component="tbody">{body.map((row, rowIndex) => <Box component="tr" key={rowIndex}>
        {Array.from({ length: columns }, (_, index) => <Box component="td" key={index}>{row[index] ?? ""}</Box>)}
      </Box>)}</Box>
    </Box>
  </Box>;
}

function DocumentBody({ document, extension }: { document: DocumentContent; extension: string | undefined }) {
  const text = document.text ?? "";
  if (MARKDOWN.has(extension ?? "")) {
    return <Suspense fallback={<Box component="pre" className="document-plain">{text}</Box>}>
      <MarkdownMessage>{text}</MarkdownMessage>
    </Suspense>;
  }
  if (TABULAR.has(extension ?? "")) return <TabularPreview text={text} separator={extension === "tsv" ? "\t" : ","} />;
  // Everything else — .txt, .json, .yaml, and the prose lifted out of a .docx or
  // .pdf — is shown as it came out of extraction. Rendering extracted text as
  // markdown would invent headings and lists the document never had.
  return <Box component="pre" className="document-plain">{text}</Box>;
}

export function DocumentWorkspace({ sessionRef = null }: { sessionRef?: string | null }) {
  const { locale } = useUiPreferences();
  const [index, setIndex] = useState<LoadState<Listing>>({ state: "idle" });
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<LoadState<DocumentContent>>({ state: "idle" });
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setIndex({ state: "loading" }); setSelected(null); setDocument({ state: "idle" });
    void readDocumentIndex(sessionRef, controller.signal)
      .then((value) => setIndex({ state: "ready", value }))
      .catch(() => { if (!controller.signal.aborted) setIndex({ state: "error" }); });
    return () => controller.abort();
  }, [sessionRef]);

  useEffect(() => {
    if (!selected) { setDocument({ state: "idle" }); return; }
    const controller = new AbortController();
    setDocument({ state: "loading" });
    void readDocument(sessionRef, selected, controller.signal)
      .then((value) => { setDocument({ state: "ready", value }); bodyRef.current?.scrollTo({ top: 0 }); })
      .catch(() => { if (!controller.signal.aborted) setDocument({ state: "error" }); });
    return () => controller.abort();
  }, [sessionRef, selected]);

  const listing = index.value;
  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => (listing?.documents ?? [])
    .filter((entry) => !needle || entry.relativePath.toLowerCase().includes(needle)), [listing, needle]);
  const grouped = useMemo(() => (listing?.roots ?? [])
    .map((root) => ({ root, entries: matches.filter((entry) => entry.rootRef === root.rootRef) }))
    .filter((group) => group.entries.length > 0), [listing, matches]);
  const selectedEntry = matches.find((entry) => entry.documentRef === selected)
    ?? listing?.documents.find((entry) => entry.documentRef === selected);

  return <section className="document-workspace surface" aria-labelledby="documents-heading">
    <header className="document-heading">
      <div><p className="section-kicker">{localize(locale, "Chỉ đọc · không sửa file", "Read only · never writes")}</p>
        <h2 id="documents-heading">{localize(locale, "Tài liệu", "Documents")}</h2></div>
      <span>{listing ? `${listing.documents.length}${listing.truncated ? "+" : ""} ${localize(locale, "tài liệu", "documents")}` : "—"}</span>
    </header>

    <div className="document-body">
      <aside className="document-list" aria-label={localize(locale, "Danh sách tài liệu", "Document list")}>
        <TextField size="small" fullWidth value={filter} onChange={(event) => setFilter(event.target.value)}
          placeholder={localize(locale, "Lọc theo tên hoặc thư mục…", "Filter by name or folder…")}
          slotProps={{
            // aria-label passed to TextField lands on the wrapper, where nothing
            // reads it. htmlInput is what reaches the input the operator focuses.
            htmlInput: { "aria-label": localize(locale, "Lọc tài liệu", "Filter documents") },
            input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }
          }} />

        {index.state === "loading" && <p className="document-empty">{localize(locale, "Đang quét tài liệu…", "Scanning for documents…")}</p>}
        {index.state === "error" && <p className="document-empty">{localize(locale, "Không đọc được danh sách tài liệu.", "The document list could not be read.")}</p>}
        {listing?.state === "unavailable" && <p className="document-empty">{label(listing.reasonCode, locale)}</p>}
        {index.state === "ready" && listing?.state === "ready" && grouped.length === 0 &&
          <p className="document-empty">{needle ? localize(locale, "Không có tài liệu nào khớp bộ lọc.", "No document matches the filter.")
            : localize(locale, "Chưa tìm thấy tài liệu nào.", "No documents were found.")}</p>}

        {grouped.map((group) => <div className="document-group" key={group.root.rootRef}>
          <div className="document-group-heading">
            <strong>{rootLabel(group.root, locale)}</strong>
            <span title={group.root.path}>{group.root.path}</span>
          </div>
          {group.entries.map((entry: Entry) => <ListItemButton component="button" type="button" key={entry.documentRef}
            className="document-row" selected={entry.documentRef === selected} onClick={() => setSelected(entry.documentRef)}>
            <DescriptionRounded fontSize="small" aria-hidden="true" />
            <span className="document-row-copy">
              <strong>{entry.name}</strong>
              <small>{entry.relativePath}</small>
            </span>
            <span className="document-row-meta">{entry.extension} · {formatSize(entry.sizeBytes)}</span>
          </ListItemButton>)}
        </div>)}

        {listing?.truncated && <p className="document-empty">{localize(locale,
          "Danh sách đã đạt giới hạn; dùng bộ lọc để thu hẹp.", "The list reached its limit; use the filter to narrow it.")}</p>}
      </aside>

      <div className="document-viewer" ref={bodyRef}>
        {!selected && <div className="document-placeholder"><DescriptionRounded aria-hidden="true" />
          <Typography variant="body2">{localize(locale, "Chọn một tài liệu để đọc nội dung tại đây.", "Pick a document to read it here.")}</Typography>
          <Typography variant="caption" color="text.disabled">{localize(locale,
            "Hỗ trợ .md .txt .csv .json .yaml .docx .pdf", "Supports .md .txt .csv .json .yaml .docx .pdf")}</Typography></div>}

        {selected && document.state === "loading" && <p className="document-empty">{localize(locale, "Đang mở tài liệu…", "Opening the document…")}</p>}
        {selected && document.state === "error" && <p className="document-empty">{localize(locale, "Không mở được tài liệu này.", "This document could not be opened.")}</p>}

        {document.state === "ready" && document.value && <>
          <div className="document-toolbar">
            <div><strong>{document.value.name ?? selectedEntry?.name ?? "—"}</strong>
              <small>{document.value.relativePath ?? selectedEntry?.relativePath ?? ""}</small></div>
            <div className="document-badges">
              {document.value.format && <Chip size="small" variant="outlined" label={document.value.format} />}
              {document.value.truncated && <Chip size="small" color="warning" variant="outlined"
                label={localize(locale, "Đã cắt bớt", "Truncated")} />}
              {document.value.redacted && <Chip size="small" color="warning" variant="outlined"
                label={localize(locale, "Đã che dữ liệu nhạy cảm", "Sensitive data redacted")} />}
            </div>
          </div>
          {document.value.state === "unavailable"
            ? <p className="document-empty">{label(document.value.reasonCode, locale)}</p>
            : <article className="document-content"><DocumentBody document={document.value} extension={selectedEntry?.extension} /></article>}
        </>}
      </div>
    </div>
  </section>;
}
