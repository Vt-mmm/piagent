import { useEffect, useMemo, useRef, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIAuthenticatedModelCatalogV1 } from "../../contracts/generated/model-catalog-v1.ts";
import { readModelCatalog, sendSessionOptionCommand } from "./api.ts";
import { createSessionOptionCommand } from "./chat-command.ts";
import { label } from "./view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

export function SessionOptionsPanel({ snapshot, refreshSnapshot }: { snapshot: PiagentWebUICanonicalSnapshotV1;
  refreshSnapshot?: () => Promise<PiagentWebUICanonicalSnapshotV1 | undefined> }) {
  const { locale } = useUiPreferences();
  const [catalog, setCatalog] = useState<PiagentWebUIAuthenticatedModelCatalogV1>();
  const [modelRef, setModelRef] = useState("");
  const [thinking, setThinking] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<"model" | "thinking" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const reloadSequence = useRef(0);
  const selectionState = useRef({ revision: 0, modelDirty: false, thinkingDirty: false });
  const capability = snapshot.capabilities.capabilities["control.sessionOptions"];
  const actions = capability.status === "available" ? capability.actions : null;

  const reload = async (signal?: AbortSignal) => {
    const sequence = ++reloadSequence.current;
    const selectionRevision = selectionState.current.revision;
    try {
      const value = await readModelCatalog(signal);
      if (sequence !== reloadSequence.current) return value;
      setCatalog(value);
      if (value.state === "ready" && selectionRevision === selectionState.current.revision) {
        if (!selectionState.current.modelDirty) setModelRef(value.activeModelRef ?? "");
        if (!selectionState.current.thinkingDirty) setThinking(value.activeThinkingLevel ?? "off");
      }
      return value;
    } catch { if (!signal?.aborted && sequence === reloadSequence.current) setCatalog(undefined); return undefined; }
  };
  useEffect(() => {
    const controller = new AbortController(); void reload(controller.signal); return () => controller.abort();
  }, [snapshot.identity.sessionRef, snapshot.revision.sessionOptionRevision]);

  const activeModel = useMemo(() => catalog?.models.find((model) => model.modelRef === catalog.activeModelRef), [catalog]);
  const apply = async (kind: "model" | "thinking") => {
    if (!acknowledged || pending || !catalog || catalog.state !== "ready") return;
    const action = kind === "model" ? "session-options.set-model" as const : "session-options.set-thinking" as const;
    const target = kind === "model" ? modelRef : thinking;
    setPending(kind); setStatus(null);
    try {
      const receipt = await sendSessionOptionCommand(await createSessionOptionCommand(snapshot, action, target));
      setStatus(receipt.resultCode === "changed" ? localize(locale, "Đã cập nhật trong Pi và mặc định người dùng", "Updated in Pi and user defaults")
        : receipt.resultCode === "unchanged" ? localize(locale, "Giá trị này đang được dùng", "This value is already active")
          : receipt.resultCode === "effect-unknown" ? localize(locale, "Pi chưa xác nhận được hậu trạng thái; hãy tải lại trước khi thử tiếp", "Pi could not confirm the resulting state; refresh before trying again")
            : `${localize(locale, "Chưa thay đổi", "Not changed")} · ${label(receipt.resultCode, locale)}`);
      setAcknowledged(false);
      selectionState.current.revision += 1;
      if (kind === "model") selectionState.current.modelDirty = false;
      else selectionState.current.thinkingDirty = false;
      await refreshSnapshot?.(); await reload();
    } catch { setStatus(localize(locale, "Không thể đổi; trạng thái Pi có thể đã thay đổi.", "Unable to change the setting; Pi state may have changed.")); }
    finally { setPending(null); }
  };

  return (
    <section className="session-options surface" aria-labelledby="session-options-title">
      <div className="session-options-copy">
        <p className="section-kicker">Model &amp; thinking</p>
        <h2 id="session-options-title">{localize(locale, "Thiết lập cho Pi session", "Pi session settings")}</h2>
        <p>{localize(locale, "Chỉ thay đổi khi Pi đang chờ. Thao tác này không gọi model, nhưng Pi 0.84.1 cũng cập nhật mặc định người dùng.", "Settings can only change while Pi is idle. This does not call the model, but Pi 0.84.1 also updates user defaults.")}</p>
      </div>
      {catalog?.state === "ready" ? <div className="session-options-controls">
        <label><span>Model</span><select aria-label={localize(locale, "Chọn model", "Select model")} value={modelRef} disabled={pending !== null || !actions?.setModel.available}
          onChange={(event) => { selectionState.current.revision += 1; selectionState.current.modelDirty = true;
            setModelRef(event.target.value); setAcknowledged(false); setStatus(null); }}>
          {catalog.models.map((model) => <option value={model.modelRef} key={model.modelRef}>{model.displayName} · {model.provider}</option>)}
        </select></label>
        <label><span>Thinking</span><select aria-label={localize(locale, "Chọn thinking", "Select thinking")} value={thinking} disabled={pending !== null || !actions?.setThinking.available}
          onChange={(event) => { selectionState.current.revision += 1; selectionState.current.thinkingDirty = true;
            setThinking(event.target.value); setAcknowledged(false); setStatus(null); }}>
          {(activeModel?.supportedThinkingLevels ?? []).map((level) => <option value={level} key={level}>{label(level, locale)}</option>)}
        </select></label>
        <label className="effect-ack"><input type="checkbox" checked={acknowledged} disabled={pending !== null || !actions}
          onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>{localize(locale, "Tôi hiểu thay đổi này áp dụng cho session và mặc định người dùng.", "I understand this applies to the session and user defaults.")}</span></label>
        <div className="session-option-actions">
          <button type="button" disabled={!acknowledged || pending !== null || !actions?.setModel.available || modelRef === catalog.activeModelRef}
            onClick={() => void apply("model")}>{pending === "model" ? localize(locale, "Đang đổi…", "Changing…") : localize(locale, "Đổi model", "Change model")}</button>
          <button type="button" disabled={!acknowledged || pending !== null || !actions?.setThinking.available || thinking === catalog.activeThinkingLevel}
            onClick={() => void apply("thinking")}>{pending === "thinking" ? localize(locale, "Đang đổi…", "Changing…") : localize(locale, "Đổi thinking", "Change thinking")}</button>
        </div>
        {status && <small role="status">{status}</small>}
        {!actions?.setModel.available && <small>{localize(locale, "Đang khóa thay đổi", "Changes locked")} · {label(actions?.setModel.reasonCode
          ?? (capability.status === "unavailable" ? capability.reason?.code : "unavailable"), locale)}</small>}
      </div> : <div className="session-options-unavailable"><strong>{localize(locale, "Catalog model chưa sẵn sàng", "Model catalog unavailable")}</strong><span>{label(catalog?.reasonCode ?? "authenticated-model-catalog-unavailable", locale)}</span></div>}
    </section>
  );
}
