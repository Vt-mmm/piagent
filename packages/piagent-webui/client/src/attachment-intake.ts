import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Attachment, DiscardReceipt, StageCommand, StageReceipt } from "../../contracts/generated/attachment-v1.ts";
import { createAttachmentCommand, createAttachmentDiscardCommand } from "./chat-command.ts";
import { label } from "./view-model.ts";

// Declared here rather than imported from ui-preferences.tsx: this module is
// plain .ts and the repository typechecks .ts without JSX, so reaching into a
// .tsx for two lines breaks the build for everything downstream. view-model.ts
// spells the locale out the same way.
export type UiLocale = "vi" | "en";
function localize(locale: UiLocale, vi: string, en: string): string { return locale === "vi" ? vi : en; }

// Shared by both composers. The in-session WebUI and the Gateway hub stage
// against different endpoints, but everything in front of that endpoint — which
// extensions are offered, what each kind may weigh, how a chip reads — has to be
// one answer. Two copies would drift, and the drift would show up as a file that
// attaches on one screen and is refused on the other.

export type DeclaredMimeType = StageCommand["file"]["declaredMimeType"];

// The extension decides the declared type, not the browser's guess. `file.type`
// is host-dependent for exactly the formats this feature is about — Windows
// reports .csv as application/vnd.ms-excel and several browsers report .md as an
// empty string — so trusting it refuses good files on some machines and not
// others. The extension is also what the runtime picks an extractor by.
export const MIME_BY_EXTENSION: Record<string, DeclaredMimeType> = {
  txt: "text/plain", text: "text/plain", md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  yaml: "application/yaml", yml: "application/yaml", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp"
};
export const supportedAttachmentAccept = Object.keys(MIME_BY_EXTENSION).map((extension) => `.${extension}`).join(",");
export const DOCUMENT_MIMES = new Set<string>(["application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
export const MAX_ATTACHMENTS = 4;

export function formatSize(value: number): string {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${(value / 1024).toFixed(value < 10_240 ? 1 : 0)} KiB`;
}

// A document is the one attachment whose size on screen would otherwise mislead:
// what Pi reads is the extracted text, not the file the operator picked, and a
// 2 MB .docx that yields 40 KB of prose costs a fortieth of what its name says.
export function attachmentDetail(item: Attachment, locale: UiLocale): string {
  const cut = item.truncated ? ` · ${localize(locale, "đã cắt bớt", "truncated")}` : "";
  if (item.kind === "image") return `${localize(locale, "Ảnh", "Image")} · ${formatSize(item.sizeBytes)}`;
  if (item.kind === "document") {
    return `${localize(locale, "Tài liệu", "Document")} · ${formatSize(item.sourceBytes)} → ${formatSize(item.sizeBytes)} ${localize(locale, "văn bản", "text")}${cut}`;
  }
  return `File · ${formatSize(item.sizeBytes)}${cut}`;
}

export function acceptAttribute(allowed: ReadonlySet<string>): string {
  return [...allowed, ...Object.entries(MIME_BY_EXTENSION).filter(([, mime]) => allowed.has(mime)).map(([extension]) => `.${extension}`)].join(",");
}

export function dragCarriesFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && [...transfer.types].includes("Files"));
}

export type StageOutcome = { attachments: Attachment[]; status: string | null };

// Stages each file in turn and reports the first thing that went wrong, leaving
// every file that did stage attached. Refusing the whole batch because one file
// was the wrong type would throw away work the operator already did.
export async function stageFiles(input: {
  files: FileList | readonly File[];
  snapshot: PiagentWebUICanonicalSnapshotV1;
  messageRequestId: string;
  existing: Attachment[];
  allowed: ReadonlySet<string>;
  locale: UiLocale;
  stage(command: StageCommand): Promise<StageReceipt | DiscardReceipt>;
}): Promise<StageOutcome> {
  const { snapshot, locale } = input;
  let next = [...input.existing], status: string | null = null;
  const room = Math.max(0, MAX_ATTACHMENTS - next.length);
  if (input.files.length > room) {
    status = localize(locale, `Chỉ nhận tối đa ${MAX_ATTACHMENTS} file mỗi tin nhắn; đã bỏ qua ${input.files.length - room} file.`,
      `At most ${MAX_ATTACHMENTS} files per message; ${input.files.length - room} skipped.`);
  }
  for (const file of [...input.files].slice(0, room)) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "", declared = MIME_BY_EXTENSION[extension];
    if (!declared) { status = `${file.name}: ${localize(locale, "loại file chưa được hỗ trợ.", "unsupported file type.")}`; continue; }
    // The host publishes exactly what it will take — .pdf disappears from the
    // list on a machine without the converter, images on a model without vision
    // — so refusing here says which of those it is, before spending an upload.
    if (!input.allowed.has(declared)) {
      status = `${file.name}: ${declared === "application/pdf"
        ? localize(locale, "host chưa cài pdftotext (poppler) nên chưa đọc được .pdf.", "this host has no pdftotext (poppler), so .pdf cannot be read.")
        : localize(locale, "phiên Pi hiện tại không nhận loại file này.", "the current Pi session does not accept this file type.")}`;
      continue;
    }
    const itemLimit = declared.startsWith("image/") || DOCUMENT_MIMES.has(declared)
      ? Math.min(snapshot.capabilities.limits.maxAttachmentFileBytes, 8 * 1024 * 1024) : 256 * 1024;
    if (file.size < 1 || file.size > itemLimit
      || next.reduce((sum, item) => sum + item.sourceBytes, 0) + file.size > snapshot.capabilities.limits.maxAttachmentTotalBytes) {
      status = `${file.name}: ${DOCUMENT_MIMES.has(declared)
        ? localize(locale,
          `vượt giới hạn gửi trực tiếp ${formatSize(itemLimit)}. Hãy đặt tài liệu lớn trong project rồi mở ở mục Tài liệu; Pi sẽ đọc theo phần thay vì nhét cả file vào chat.`,
          `exceeds the ${formatSize(itemLimit)} direct-send limit. Put a large document in the project and open Documents; Pi can read it in parts instead of placing the whole file in chat.`)
        : localize(locale, `vượt giới hạn đính kèm (tối đa ${formatSize(itemLimit)}).`, `attachment limit exceeded (max ${formatSize(itemLimit)}).`)}`;
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    const receipt = await input.stage(await createAttachmentCommand(snapshot, input.messageRequestId,
      { displayName: file.name, declaredMimeType: declared, dataBase64: btoa(binary) }));
    if (receipt.resultCode !== "staged" || !("attachment" in receipt) || !receipt.attachment) {
      status = `${file.name}: ${label(receipt.error?.code ?? receipt.resultCode, locale)}`; continue;
    }
    next = [...next, receipt.attachment];
  }
  return { attachments: next, status };
}

export async function discardAttachment(input: {
  snapshot: PiagentWebUICanonicalSnapshotV1;
  messageRequestId: string;
  attachmentRef: string;
  locale: UiLocale;
  stage(command: ReturnType<typeof createAttachmentDiscardCommand>): Promise<StageReceipt | DiscardReceipt>;
}): Promise<{ discarded: boolean; status: string | null }> {
  const receipt = await input.stage(createAttachmentDiscardCommand(input.snapshot, input.messageRequestId, input.attachmentRef));
  if (receipt.messageType === "discard-receipt" && receipt.resultCode === "discarded") return { discarded: true, status: null };
  return { discarded: false,
    status: `${localize(input.locale, "Chưa thể bỏ file", "Unable to remove file")} · ${label(receipt.error?.code ?? receipt.resultCode, input.locale)}` };
}
