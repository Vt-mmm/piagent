// Document MIME types an attachment may declare, shared by the store that
// extracts them and the transcript that labels them. Kept apart from the store
// so a reader of the transcript does not load the staging machinery.
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PDF_MIME = "application/pdf";
// Spreadsheets, slide decks, OpenDocument and RTF: read in-process like .docx,
// keyed by MIME type to the extension the shared extractor dispatches on.
export const OFFICE_MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf"
});
export const OFFICE_MIMES = Object.keys(OFFICE_MIME_EXTENSIONS);
export const DOCUMENT_MIMES: ReadonlySet<string> = new Set([DOCX_MIME, PDF_MIME, ...OFFICE_MIMES]);
