/* Generated from schemas/piagent-webui/document-workspace-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedDocumentWorkspaceV1 = Listing | Document;
export type Listing = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-document-workspace-v1";
  messageType: "listing";
  generatedAt: string;
  state: "ready" | "unavailable";
  /**
   * @maxItems 32
   */
  roots: Root[];
  /**
   * @maxItems 2000
   */
  documents: Entry[];
  truncated: boolean;
  reasonCode: string | null;
};
export type DisplayText = string;
export type Document = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-document-workspace-v1";
  messageType: "document";
  generatedAt: string;
  documentRef: string;
  state: "ready" | "unavailable";
  name: NullableDisplayText;
  relativePath: NullableDisplayText;
  rootRef: string | null;
  format: "text" | "docx" | "pdf" | null;
  text: string | null;
  sizeBytes: number | null;
  truncated: boolean;
  redacted: boolean;
  reasonCode: string | null;
};
export type NullableDisplayText = DisplayText | null;

export interface Root {
  rootRef: string;
  path: DisplayText;
  source: "project" | "profile" | "environment";
  documentCount: number;
}
export interface Entry {
  documentRef: string;
  rootRef: string;
  name: DisplayText;
  relativePath: DisplayText;
  extension: "md" | "markdown" | "txt" | "text" | "csv" | "tsv" | "json" | "yaml" | "yml" | "pdf" | "docx";
  sizeBytes: number;
  modifiedAt: string;
}
