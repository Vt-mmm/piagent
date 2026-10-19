import { createContext, useContext, useEffect, useState } from "react";

import { changedSince, commentKey, fileFindings, findingsAt, keyOf, type LineComment, type LineSide, type ReviewFinding } from "./line-review.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// What a diff line needs to show comments and findings and to open a comment.
export type LineReviewValue = { locale: UiLocale; findings?: readonly ReviewFinding[]; comments: LineComment[]; editing: string | null;
  open(path: string, side: LineSide, line: number, code: string): void; save(text: string): void; cancel(): void; remove(key: string): void };
export const LineReviewContext = createContext<LineReviewValue | null>(null);
export const useLineReview = () => useContext(LineReviewContext);

const SEVERITY: Record<ReviewFinding["severity"], [string, string]> = { blocking: ["Chặn", "Blocking"], major: ["Nặng", "Major"], minor: ["Nhẹ", "Minor"] };

function Finding({ finding, locale }: { finding: ReviewFinding; locale: UiLocale }) {
  return <div className={`line-finding severity-${finding.severity}`} role="note">
    <strong>Review · {localize(locale, ...SEVERITY[finding.severity])}</strong><span>{finding.issue}</span></div>;
}

function Editor({ initial, locale, onSave, onCancel }: { initial: string; locale: UiLocale; onSave(text: string): void; onCancel(): void }) {
  const [text, setText] = useState(initial);
  return <form className="line-comment-editor" onSubmit={(event) => { event.preventDefault(); onSave(text); }}>
    <textarea autoFocus rows={3} maxLength={2000} value={text} aria-label={localize(locale, "Comment cho dòng này", "Comment on this line")}
      placeholder={localize(locale, "Agent cần sửa gì ở dòng này?", "What should the agent change here?")} onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSave(text); }} />
    <div><button type="button" onClick={onCancel}>{localize(locale, "Hủy", "Cancel")}</button>
      <button type="submit" disabled={!text.trim()}>{localize(locale, "Lưu comment", "Save comment")}</button></div>
  </form>;
}

// The notes under one diff line: the review helper's findings on it, the
// member's comment, or the open comment editor.
export function LineNotes({ path, side, line }: { path: string; side: LineSide; line: number | null }) {
  const review = useLineReview();
  if (!review || line === null) return null;
  const key = commentKey(path, side, line), comment = review.comments.find((c) => keyOf(c) === key);
  const findings = side === "new" ? findingsAt(review.findings, path, line) : [];
  if (!findings.length && !comment && review.editing !== key) return null;
  return <div className="line-notes">
    {findings.map((finding, index) => <Finding key={index} finding={finding} locale={review.locale} />)}
    {review.editing === key ? <Editor initial={comment?.text ?? ""} locale={review.locale} onSave={review.save} onCancel={review.cancel} />
      : comment && <div className="line-comment"><span>{comment.text}</span>
        <button type="button" onClick={() => review.open(path, side, line, comment.code)}>{localize(review.locale, "Sửa", "Edit")}</button>
        <button type="button" onClick={() => review.remove(key)}>{localize(review.locale, "Xóa", "Delete")}</button></div>}
  </div>;
}

// The line number, as a button that opens a comment on that line.
export function LineAnchor({ path, side, line, code }: { path: string; side: LineSide; line: number | null; code: string }) {
  const review = useLineReview();
  if (!review || line === null) return <span>{line ?? ""}</span>;
  return <span><button type="button" className="line-comment-anchor" onClick={() => review.open(path, side, line, code)}
    aria-label={localize(review.locale, `Comment dòng ${line}`, `Comment on line ${line}`)}>{line}</button></span>;
}

// Findings on this file that no shown line carries.
export function FileFindings({ path, shownLines }: { path: string; shownLines: ReadonlySet<number> }) {
  const review = useLineReview();
  const rest = review ? fileFindings(review.findings, path, shownLines) : [];
  if (!review || !rest.length) return null;
  return <div className="line-notes file-findings">{rest.map((finding, index) => <div key={index} className={`line-finding severity-${finding.severity}`} role="note">
    <strong>Review · {localize(review.locale, ...SEVERITY[finding.severity])}{finding.line ? ` · ${localize(review.locale, "dòng", "line")} ${finding.line}` : ""}</strong>
    <span>{finding.issue}</span></div>)}</div>;
}

// The pending comments of this conversation and the button that puts them
// into its composer as one message.
export function CommentBar({ comments, lines, linesPath, locale, onSend, onClear }: { comments: LineComment[]; lines?: ReadonlyMap<string, string>;
  linesPath?: string; locale: UiLocale; onSend(): void; onClear(): void }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!comments.length) setConfirming(false); }, [comments.length]);
  if (!comments.length) return null;
  // Only the file on screen is known line by line.
  const isChanged = (c: LineComment) => c.path === linesPath && changedSince(c, lines);
  const changed = comments.filter(isChanged).length;
  return <section className="line-comment-bar" aria-label={localize(locale, "Comment chờ gửi", "Comments to send")}>
    <div><strong>{localize(locale, `${comments.length} comment chờ gửi`, `${comments.length} comments to send`)}</strong>
      {changed > 0 && <small>{localize(locale, `${changed} dòng đã đổi sau khi comment`, `${changed} lines changed since commented`)}</small>}</div>
    <ul>{comments.map((c) => <li key={keyOf(c)} className={isChanged(c) ? "changed" : undefined}>
      <code>{c.path}:{c.line}</code><span>{c.text}</span>{isChanged(c) && <em>{localize(locale, "đã đổi", "changed")}</em>}</li>)}</ul>
    <div className="line-comment-actions">
      {confirming ? <><span>{localize(locale, "Xóa hết comment?", "Delete every comment?")}</span>
        <button type="button" onClick={() => setConfirming(false)}>{localize(locale, "Không", "No")}</button>
        <button type="button" onClick={onClear}>{localize(locale, "Xóa hết", "Delete all")}</button></>
        : <button type="button" onClick={() => setConfirming(true)}>{localize(locale, "Xóa hết", "Delete all")}</button>}
      <button type="button" className="primary" onClick={onSend}>{localize(locale, "Đưa vào ô chat", "Put in the composer")}</button>
    </div>
  </section>;
}
