/* Generated from schemas/piagent-webui/document-asset-v1.schema.json. Do not edit. */

export type PiagentWebUIChangeReportScreenshotV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-document-asset-v1";
  generatedAt: string;
  documentRef: string;
  name: string | null;
  state: "ready" | "unavailable";
  mediaType: "image/png" | null;
  sizeBytes: number | null;
  base64: string | null;
  reasonCode: string | null;
};
