export const WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE = "piagent-webui-message-correlation";

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

export type WebUiMessageCorrelation = {
  messageRequestId: string;
  operationRef: string;
};

/**
 * A correlation marker is persisted immediately before the host receives the
 * user prompt. Plain custom entries do not enter model context, but they let a
 * later transcript projection recover the exact browser request and operation
 * without trusting browser/server clock alignment or repeated message text.
 */
export function webUiMessageCorrelationEntry(entry: unknown): WebUiMessageCorrelation | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const candidate = entry as Record<string, any>;
  if (candidate.type !== "custom" || candidate.customType !== WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE
    || !candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) return null;
  const data = candidate.data as Record<string, unknown>;
  if (data.schemaVersion !== 1 || typeof data.messageRequestId !== "string" || !OPAQUE_REF.test(data.messageRequestId)
    || typeof data.operationRef !== "string" || !OPAQUE_REF.test(data.operationRef)) return null;
  return { messageRequestId: data.messageRequestId, operationRef: data.operationRef };
}
