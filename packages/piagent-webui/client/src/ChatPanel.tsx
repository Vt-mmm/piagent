import { useEffect, useMemo, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedTranscriptProjectionV1, TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import type { PiagentWebUIHeldMessageQueueProjectionV1 } from "../../contracts/generated/queue-v1.ts";
import { readHeldQueue, readTranscript, sendResumeAndContinueCommand, stageAttachment } from "./api.ts";
import { liveChatState, mergeOlderTranscriptPage, type RuntimeStreamEvent } from "./chat-view-model.ts";
import { label } from "./view-model.ts";
import { createAttachmentCommand, createAttachmentDiscardCommand, createChatCommand, createQueueCommand,
  createResumeAndContinueCommand, queueUpdatePayload } from "./chat-command.ts";
import { sendChatCommand } from "./api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

export function ChatPanel({ snapshot, events, refreshSnapshot }: { snapshot: PiagentWebUICanonicalSnapshotV1; events: RuntimeStreamEvent[];
  refreshSnapshot?: () => Promise<PiagentWebUICanonicalSnapshotV1 | undefined> }) {
  const { locale } = useUiPreferences();
  const [transcript, setTranscript] = useState<PiagentWebUIBoundedTranscriptProjectionV1>();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState<string | null>(null);
  const [queue, setQueue] = useState<PiagentWebUIHeldMessageQueueProjectionV1>();
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [messageRequestId, setMessageRequestId] = useState(() => `message-request.${crypto.randomUUID()}`);
  const [attachments, setAttachments] = useState<Array<{ attachmentRef: string; displayName: string; kind: "file" | "image"; mimeType: string; sizeBytes: number }>>([]);
  const [uploading, setUploading] = useState(false);
  const live = useMemo(() => liveChatState(events), [events]);
  const completedCursor = [...events].reverse().find((event) => ["message.completed", "message.failed", "agent-operation.settled"].includes(String(event.kind)))?.eventCursor ?? null;

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setTranscript(undefined);
    void readTranscript(null, 50, controller.signal).then((value) => setTranscript(value)).catch(() => undefined).finally(() => setLoading(false));
    return () => controller.abort();
  }, [snapshot.identity.sessionRef]);

  useEffect(() => { setAttachments([]); setMessageRequestId(`message-request.${crypto.randomUUID()}`); }, [snapshot.identity.sessionRef]);

  useEffect(() => {
    if (!completedCursor) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void readTranscript(null, 50, controller.signal).then((value) => setTranscript(value)).catch(() => undefined);
    }, 80);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [completedCursor]);

  const refreshQueue = async () => {
    try { const value = await readHeldQueue(); setQueue(value); return value; }
    catch { return undefined; }
  };

  useEffect(() => {
    const controller = new AbortController();
    void readHeldQueue(controller.signal).then(setQueue).catch(() => undefined);
    return () => controller.abort();
  }, [snapshot.identity.sessionRef, snapshot.revision.queueRevision]);

  const loadOlder = async () => {
    const before = transcript?.page.nextBeforeCursor; if (!before) return;
    try {
      const older = await readTranscript(before, transcript.page.limit);
      setTranscript((current) => current ? { ...current, items: mergeOlderTranscriptPage(current.items, older.items), page: older.page } : older);
    } catch { /* retain the current bounded page */ }
  };

  const items = transcript?.state === "ready" ? transcript.items : [];
  const chatCapability = snapshot.capabilities.capabilities["control.chat"];
  const chatActions = chatCapability.status === "available" ? chatCapability.actions : null;
  const chatAvailable = Boolean(chatActions?.send.available);
  const resumeAndContinue = snapshot.capabilities.capabilities["control.resumeAndContinue"];
  const compoundAvailable = resumeAndContinue.status === "available";
  const composerAvailable = chatAvailable || compoundAvailable;
  const attachmentCapability = snapshot.capabilities.capabilities.attachments;
  const attachmentAvailable = attachmentCapability.status === "available";
  const running = snapshot.session.operation.liveness === "running";
  const settleControl = async () => {
    await refreshSnapshot?.();
    await refreshQueue();
  };
  const submit = async (delivery: "new-operation" | "follow-up" | "steer" | "hold" | "resume-and-continue") => {
    const text = draft.trim();
    if (!text || sending || (delivery === "resume-and-continue" ? !compoundAvailable : !chatAvailable)) return;
    setSending(true); setSendState(null);
    try {
      const attachment = attachments.length ? { messageRequestId, attachmentRefs: attachments.map((item) => item.attachmentRef) } : undefined;
      const receipt = delivery === "resume-and-continue"
        ? await sendResumeAndContinueCommand(await createResumeAndContinueCommand(snapshot, text, attachment))
        : await sendChatCommand(await createChatCommand(snapshot, text, delivery, attachment));
      if (["dispatch-observed", "dispatch-requested"].includes(receipt.resultCode)) {
        setDraft(""); setAttachments([]); setMessageRequestId(`message-request.${crypto.randomUUID()}`);
        setSendState(receipt.resultCode === "dispatch-observed" ? localize(locale, "Đã gửi vào Pi session", "Sent to the Pi session") : localize(locale, "Pi đã nhận yêu cầu", "Pi received the request"));
      } else if (receipt.resultCode === "held") { setDraft(""); setSendState(localize(locale, "Đã giữ trong hàng đợi", "Held in the queue")); }
      else if (receipt.resultCode === "resumed-not-dispatched") setSendState(localize(locale, "Task đã mở lại nhưng tin nhắn chưa được gửi; nội dung vẫn được giữ để anh kiểm tra.", "The task resumed but the message was not sent; the content remains for review."));
      else setSendState(`${localize(locale, "Chưa gửi", "Not sent")} · ${label(receipt.resultCode, locale)}`);
      await settleControl();
    } catch { setSendState(localize(locale, "Không thể gửi; trạng thái Pi có thể đã thay đổi.", "Unable to send; Pi state may have changed.")); }
    finally { setSending(false); }
  };
  const selectFiles = async (files: FileList | null) => {
    if (!files?.length || !attachmentAvailable || uploading) return;
    setUploading(true); setSendState(null);
    try {
      let next = [...attachments];
      for (const file of [...files].slice(0, Math.max(0, 4 - next.length))) {
        const extension = file.name.split(".").pop()?.toLowerCase(), declared = file.type || ({ txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
          json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>)[extension ?? ""];
        if (!declared) { setSendState(`${file.name}: ${localize(locale, "loại file chưa được hỗ trợ.", "unsupported file type.")}`); continue; }
        const itemLimit = declared.startsWith("image/") ? Math.min(snapshot.capabilities.limits.maxAttachmentFileBytes, 8 * 1024 * 1024) : 256 * 1024;
        if (file.size < 1 || file.size > itemLimit || next.reduce((sum, item) => sum + item.sizeBytes, 0) + file.size > snapshot.capabilities.limits.maxAttachmentTotalBytes) {
          setSendState(`${file.name}: ${localize(locale, "vượt giới hạn đính kèm.", "attachment limit exceeded.")}`); continue;
        }
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        const receipt = await stageAttachment(await createAttachmentCommand(snapshot, messageRequestId,
          { displayName: file.name, declaredMimeType: declared as any, dataBase64: btoa(binary) }));
        if (receipt.resultCode !== "staged" || !receipt.attachment) { setSendState(`${file.name}: ${label(receipt.error?.code ?? receipt.resultCode, locale)}`); continue; }
        next = [...next, receipt.attachment]; setAttachments(next);
      }
    } catch { setSendState(localize(locale, "Không thể đính kèm; file không được gửi vào Pi.", "Unable to attach the file; it was not sent to Pi.")); }
    finally { setUploading(false); }
  };
  const removeAttachment = async (attachmentRef: string) => {
    if (sending || uploading) return; setUploading(true); setSendState(null);
    try {
      const receipt = await stageAttachment(createAttachmentDiscardCommand(snapshot, messageRequestId, attachmentRef));
      if (receipt.messageType === "discard-receipt" && receipt.resultCode === "discarded")
        setAttachments((current) => current.filter((entry) => entry.attachmentRef !== attachmentRef));
      else setSendState(`${localize(locale, "Chưa thể bỏ file", "Unable to remove file")} · ${label(receipt.error?.code ?? receipt.resultCode, locale)}`);
    } catch { setSendState(localize(locale, "Không thể bỏ file; trạng thái Pi có thể đã thay đổi.", "Unable to remove the file; Pi state may have changed.")); }
    finally { setUploading(false); }
  };
  const queueAction = async (action: "queue.update" | "queue.delete" | "queue.dispatch", queueItemRef: string, text?: string) => {
    if (sending) return;
    setSending(true); setSendState(null);
    try {
      const payload = action === "queue.update" ? await queueUpdatePayload(queueItemRef, text?.trim() ?? "")
        : action === "queue.delete" ? { queueItemRef }
          : { queueItemRef, messageRequestId: `message-request.${crypto.randomUUID()}` };
      const receipt = await sendChatCommand(await createQueueCommand(snapshot, action, payload));
      if (["updated", "deleted", "dispatch-observed", "dispatch-requested"].includes(receipt.resultCode)) {
        setEditingRef(null); setEditDraft(""); setSendState(label(receipt.resultCode, locale));
      } else setSendState(`${localize(locale, "Chưa thay đổi", "Not changed")} · ${label(receipt.resultCode, locale)}`);
      await settleControl();
    } catch { setSendState(localize(locale, "Hàng đợi đã thay đổi; đã tải lại trạng thái mới nhất.", "The queue changed; the latest state has been reloaded.")); await settleControl(); }
    finally { setSending(false); }
  };
  return (
    <section className="chat-panel surface" aria-labelledby="chat-heading">
      <header className="chat-heading">
        <div><p className="section-kicker">{localize(locale, "Đúng Pi session hiện tại", "Exact current Pi session")}</p><h2 id="chat-heading">Chat</h2></div>
        <div><span>{items.length} {localize(locale, "message gần nhất", "recent messages")}</span><span className="chat-read-state">{localize(locale, "Streaming trực tiếp", "Live streaming")}</span></div>
      </header>
      <div className="chat-body" aria-live="polite">
        {transcript?.page.hasOlder && <button type="button" className="load-older" onClick={() => void loadOlder()}>{localize(locale, "Tải message cũ hơn", "Load older messages")}</button>}
        {loading && <p className="chat-empty">{localize(locale, "Đang tải transcript hiện tại…", "Loading the current transcript…")}</p>}
        {!loading && transcript?.state === "unavailable" && <p className="chat-empty">{localize(locale, "Transcript cần đồng bộ lại", "Transcript needs resync")} · {label(transcript.reasonCode, locale)}</p>}
        {!loading && transcript?.state === "ready" && items.length === 0 && live.assistants.length === 0 && <p className="chat-empty">{localize(locale, "Chưa có message trong Pi session này.", "There are no messages in this Pi session.")}</p>}
        {items.map((item) => item.role === "tool-result" ? (
          <article className="chat-tool-result" key={item.messageRef}><strong>{item.toolCalls[0]?.toolName ?? "Tool"}</strong><span>{localize(locale, "Kết quả chi tiết nằm trong Activity", "Detailed output is available in Activity")}</span></article>
        ) : (
          <article className={`chat-message chat-${item.role}`} key={item.messageRef}>
            <div><strong>{item.role === "user" ? localize(locale, "Anh", "You") : "Pi"}</strong><time>{new Date(item.recordedAt).toLocaleTimeString(locale === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <p>{item.content.text || (item.content.imageCount ? `${item.content.imageCount} ${localize(locale, "ảnh đính kèm", "attached images")}` : localize(locale, "Message trống", "Empty message"))}</p>
            {(item.content.redacted || item.content.truncated) && <small>{item.content.redacted ? localize(locale, "Đã che dữ liệu nhạy cảm", "Sensitive data redacted") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}</small>}
          </article>
        ))}
        {live.assistants.map((assistant) => (
          <article className="chat-message chat-assistant chat-streaming" key={assistant.messageRef}>
            <div><strong>Pi</strong><span className="stream-indicator">{localize(locale, "Đang trả lời", "Responding")}</span></div>
            <p>{assistant.text || (assistant.thinking ? localize(locale, "Đang suy nghĩ…", "Thinking…") : localize(locale, "Đang chuẩn bị câu trả lời…", "Preparing a response…"))}</p>
            {assistant.truncated && <small>{localize(locale, "Live preview đã đạt giới hạn", "Live preview limit reached")}</small>}
          </article>
        ))}
        {live.tools.filter((tool) => ["started", "progress"].includes(tool.state)).map((tool) => (
          <article className="chat-tool-live" key={tool.toolCallId}><span className="tool-spinner" aria-hidden="true" /><strong>{tool.toolName}</strong><span>{label(tool.state, locale)}</span></article>
        ))}
      </div>
      {queue?.state === "ready" && queue.items.length > 0 && <section className="held-queue" aria-label={localize(locale, "Tin nhắn đang giữ", "Held messages")}>
        <div className="held-queue-heading"><strong>{localize(locale, `Đang giữ ${queue.heldCount} tin`, `${queue.heldCount} held messages`)}</strong>{queue.quarantinedCount > 0 && <span>{queue.quarantinedCount} {localize(locale, "tin cần kiểm tra", "need review")}</span>}</div>
        <ol>{queue.items.map((item) => <li key={item.queueItemRef} data-state={item.state}>
          {editingRef === item.queueItemRef ? <textarea aria-label={localize(locale, "Sửa tin nhắn đang giữ", "Edit held message")} rows={2} maxLength={65_536} value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)} /> : <p>{item.preview}</p>}
          <div>
            {editingRef === item.queueItemRef ? <>
              <button type="button" disabled={sending || !editDraft.trim()} onClick={() => void queueAction("queue.update", item.queueItemRef, editDraft)}>{localize(locale, "Lưu", "Save")}</button>
              <button type="button" disabled={sending} onClick={() => { setEditingRef(null); setEditDraft(""); }}>{localize(locale, "Hủy", "Cancel")}</button>
            </> : <>
              <button type="button" disabled={sending || item.state !== "held" || !chatActions?.dispatchHeld.available}
                onClick={() => void queueAction("queue.dispatch", item.queueItemRef)}>{localize(locale, "Gửi", "Send")}</button>
              <button type="button" disabled={sending || item.state !== "held" || item.redacted || item.truncated || !chatActions?.editHeld.available}
                title={item.redacted || item.truncated ? localize(locale, "Không sửa từ preview đã che hoặc rút gọn", "Redacted or truncated previews cannot be edited") : undefined}
                onClick={() => { setEditingRef(item.queueItemRef); setEditDraft(item.preview); }}>{localize(locale, "Sửa", "Edit")}</button>
              <button type="button" disabled={sending || !chatActions?.deleteHeld.available}
                onClick={() => void queueAction("queue.delete", item.queueItemRef)}>{localize(locale, "Xóa", "Delete")}</button>
            </>}
          </div>
          {(item.redacted || item.truncated || item.state === "quarantined") && <small>{item.state === "quarantined" ? localize(locale, "Lần gửi trước chưa xác định; không tự gửi lại", "The previous dispatch is uncertain; it will not be resent automatically") : item.redacted ? localize(locale, "Preview đã che dữ liệu nhạy cảm", "Sensitive data is redacted in the preview") : localize(locale, "Preview đã rút gọn", "Preview truncated")}</small>}
        </li>)}</ol>
      </section>}
      <footer className="chat-composer-preview">
        {attachments.length > 0 && <ul className="attachment-list" aria-label={localize(locale, "File sẽ gửi cùng message", "Files to send with the message")}>
          {attachments.map((item) => <li key={item.attachmentRef}><span><strong>{item.displayName}</strong><small>{item.kind === "image" ? localize(locale, "Ảnh", "Image") : "File"} · {(item.sizeBytes / 1024).toFixed(item.sizeBytes < 10240 ? 1 : 0)} KiB</small></span>
            <button type="button" disabled={sending || uploading} aria-label={`${localize(locale, "Bỏ", "Remove")} ${item.displayName}`} onClick={() => void removeAttachment(item.attachmentRef)}>{localize(locale, "Bỏ", "Remove")}</button></li>)}
        </ul>}
        <textarea aria-label={localize(locale, "Nội dung chat", "Chat message")} placeholder={compoundAvailable ? localize(locale, "Nhập việc cần Pi làm ngay sau khi mở lại task…", "Enter work for Pi immediately after the task resumes…")
          : chatAvailable ? localize(locale, "Nhắn vào đúng Pi session này…", "Message this exact Pi session…") : localize(locale, "Chat control chưa khả dụng.", "Chat control is unavailable.")}
          disabled={!composerAvailable || sending} maxLength={65_536} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="composer-actions">
          <button type="button" disabled={!composerAvailable || sending || !draft.trim()}
            onClick={() => void submit(compoundAvailable ? "resume-and-continue" : running ? "follow-up" : "new-operation")}>
            {sending ? localize(locale, "Đang gửi…", "Sending…") : compoundAvailable ? localize(locale, "Tiếp tục & gửi", "Resume & send") : running ? localize(locale, "Gửi sau", "Send next") : localize(locale, "Gửi", "Send")}
          </button>
          <button type="button" disabled={!chatAvailable || sending || !draft.trim() || attachments.length > 0 || !chatActions?.hold.available}
            title={attachments.length ? localize(locale, "Bản này chưa giữ file trong hàng đợi", "This version does not hold attachments in the queue") : undefined}
            onClick={() => void submit("hold")}>{localize(locale, "Giữ lại", "Hold")}</button>
          {running && <button type="button" className="interrupt-send" disabled={!chatAvailable || sending || !draft.trim()
            || !chatActions?.interruptAndSend.available}
            onClick={() => void submit("steer")}>{localize(locale, "Ngắt & gửi", "Interrupt & send")}</button>}
        </div>
        <label className={`attachment-picker ${!attachmentAvailable || sending || uploading || attachments.length >= 4 ? "disabled" : ""}`}>
          <input type="file" multiple disabled={!attachmentAvailable || sending || uploading || attachments.length >= 4}
            accept={attachmentCapability.status === "available" ? attachmentCapability.mimeTypes.join(",") : undefined}
            onChange={(event) => { void selectFiles(event.target.files); event.currentTarget.value = ""; }} />
          {uploading ? localize(locale, "Đang kiểm tra file…", "Checking files…") : `${localize(locale, "Đính kèm", "Attach")} (${attachments.length}/4)`}
        </label>
        {sendState && <small role="status">{sendState}</small>}
      </footer>
    </section>
  );
}
