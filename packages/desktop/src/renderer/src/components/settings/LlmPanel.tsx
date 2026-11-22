import { useEffect, useState } from "react";
import type { LlmProfileInfo } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";

interface Draft {
  id?: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  protocol: "anthropic" | "openai";
}

const MAX_PROFILES = 8;

export function LlmPanel(): React.JSX.Element {
  const llmConfig = useStore((s) => s.llmConfig);
  const saveLlmProfile = useStore((s) => s.saveLlmProfile);
  const setLlmProfileEnabled = useStore((s) => s.setLlmProfileEnabled);
  const deleteLlmProfile = useStore((s) => s.deleteLlmProfile);
  const reorderLlmProfiles = useStore((s) => s.reorderLlmProfiles);
  const saveLlmSettings = useStore((s) => s.saveLlmSettings);
  const clearLlmConfig = useStore((s) => s.clearLlmConfig);
  const t = useT();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 调用设置（超时/重试/自动选择/费用上限），随服务端配置同步、整组保存。
  const [timeoutSec, setTimeoutSec] = useState("");
  const [retries, setRetries] = useState("");
  const [autoSelect, setAutoSelect] = useState(true);
  const [budget, setBudget] = useState("");

  useEffect(() => {
    if (!llmConfig) return;
    setTimeoutSec(String(Math.round(llmConfig.settings.timeout_ms / 1000)));
    setRetries(String(llmConfig.settings.retries));
    setAutoSelect(llmConfig.settings.auto_select);
    setBudget(llmConfig.max_budget_usd != null ? String(llmConfig.max_budget_usd) : "");
  }, [llmConfig]);

  const profiles = llmConfig?.profiles ?? [];
  const preferredId = profiles.find((p) => p.enabled)?.id;
  const editingKey = draft?.id
    ? (profiles.find((p) => p.id === draft.id)?.api_key_hint ?? null)
    : null;

  const run = async (fn: () => Promise<void>, okMsg?: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("llm.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  const submitProfile = (): void => {
    if (!draft) return;
    void run(async () => {
      const name = draft.name.trim();
      if (!name) throw new Error(t("llm.nameRequired"));
      const editing = !!draft.id;
      const hasContent =
        editing ||
        !!draft.api_key.trim() ||
        !!draft.base_url.trim() ||
        !!draft.model.trim();
      if (!hasContent) throw new Error(t("llm.needContent"));
      await saveLlmProfile({
        id: draft.id,
        name,
        api_key: draft.api_key.trim() || undefined,
        // 编辑时空串 = 清除该字段；新建空值不传（服务端会拒全空的新建）。
        base_url: draft.base_url.trim() || (editing ? "" : undefined),
        model: draft.model.trim() || (editing ? "" : undefined),
        protocol: draft.protocol,
      });
      setDraft(null);
      setConfirmDel(null);
    }, t("llm.profileSaved"));
  };

  const submitSettings = (): void => {
    void run(async () => {
      const to = Number(timeoutSec.trim());
      const rt = Number(retries.trim());
      if (!Number.isFinite(to) || to < 5 || to > 600 || !Number.isFinite(rt) || rt < 0 || rt > 5) {
        throw new Error(t("llm.retrySecBad"));
      }
      const bRaw = budget.trim();
      let bud: number | null = null;
      if (bRaw !== "") {
        const n = Number(bRaw);
        if (!Number.isFinite(n) || n < 0) throw new Error(t("llm.budgetBad"));
        bud = n;
      }
      await saveLlmSettings({
        timeout_ms: Math.round(to * 1000),
        retries: Math.round(rt),
        auto_select: autoSelect,
        max_budget_usd: bud,
      });
    }, t("llm.settingsSaved"));
  };

  const move = (p: LlmProfileInfo, dir: -1 | 1): void => {
    const ids = profiles.map((x) => x.id);
    const i = ids.indexOf(p.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => reorderLlmProfiles(ids));
  };

  const remove = (p: LlmProfileInfo): void => {
    if (confirmDel !== p.id) {
      setConfirmDel(p.id);
      return;
    }
    setConfirmDel(null);
    void run(async () => {
      await deleteLlmProfile(p.id);
      if (draft?.id === p.id) setDraft(null);
    }, t("llm.profileDeleted"));
  };

  const cardStyle: React.CSSProperties = {
    border: "1px solid var(--border, #ccc)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
  };

  return (
    <>
      {/* ---- 配置列表 ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{t("llm.listTitle")}</div>
        <span style={{ flex: 1 }} />
        <button
          className="primary"
          style={{ fontSize: 12 }}
          disabled={busy || profiles.length >= MAX_PROFILES}
          onClick={() =>
            setDraft({ name: "", base_url: "", api_key: "", model: "", protocol: "anthropic" })
          }
        >
          {t("llm.addProfile")}
        </button>
      </div>

      {draft && (
        <div style={{ ...cardStyle, marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {draft.id ? t("llm.editProfile") : t("llm.addProfile")}
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("llm.profileName")}</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t("llm.profileNamePh")}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("llm.baseUrl")}</label>
            <input
              value={draft.base_url}
              onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
              placeholder={t("llm.baseUrlPh")}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>API Key</label>
            <input
              type="password"
              value={draft.api_key}
              onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
              placeholder={
                editingKey
                  ? t("llm.keyPhConfigured", { hint: editingKey })
                  : t("llm.keyPhNone")
              }
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("llm.model")}</label>
            <input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder={t("llm.modelPh")}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("llm.protocol")}</label>
            <select
              value={draft.protocol}
              onChange={(e) => setDraft({ ...draft, protocol: e.target.value as Draft["protocol"] })}
            >
              <option value="anthropic">{t("llm.protocolAnthropic")}</option>
              <option value="openai">{t("llm.protocolOpenai")}</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="primary"
              style={{ fontSize: 12 }}
              disabled={busy}
              onClick={submitProfile}
            >
              {t("llm.save")}
            </button>
            <button style={{ fontSize: 12 }} disabled={busy} onClick={() => setDraft(null)}>
              {t("llm.cancel")}
            </button>
          </div>
        </div>
      )}

      {profiles.length === 0 && !draft && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
          {t("llm.profilesEmpty")}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {profiles.map((p) => (
          <div key={p.id} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong>{p.name}</strong>
              <span style={{ fontSize: 10, color: p.enabled ? "var(--accent)" : "var(--muted)" }}>
                {p.enabled ? t("llm.enabledOn") : t("llm.enabledOff")}
              </span>
              {p.id === preferredId && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--accent)",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    padding: "0 4px",
                  }}
                >
                  {t("llm.preferred")}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button
                style={{ fontSize: 11 }}
                disabled={busy}
                onClick={() => void run(() => setLlmProfileEnabled(p.id, !p.enabled))}
              >
                {p.enabled ? t("llm.disable") : t("llm.enable")}
              </button>
              <button
                style={{ fontSize: 11 }}
                disabled={busy}
                onClick={() => {
                  setConfirmDel(null);
                  setDraft({
                    id: p.id,
                    name: p.name,
                    base_url: p.base_url ?? "",
                    api_key: "",
                    model: p.model ?? "",
                    protocol: p.protocol ?? "anthropic",
                  });
                }}
              >
                {t("llm.edit")}
              </button>
              <button
                style={{ fontSize: 11, color: confirmDel === p.id ? "var(--accent)" : undefined }}
                disabled={busy}
                onClick={() => remove(p)}
              >
                {confirmDel === p.id ? t("llm.deleteConfirm") : t("llm.delete")}
              </button>
              <button
                style={{ fontSize: 11 }}
                disabled={busy || p.id === profiles[0]?.id}
                title={t("llm.moveUp")}
                onClick={() => move(p, -1)}
              >
                ↑
              </button>
              <button
                style={{ fontSize: 11 }}
                disabled={busy || p.id === profiles[profiles.length - 1]?.id}
                title={t("llm.moveDown")}
                onClick={() => move(p, 1)}
              >
                ↓
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {p.protocol === "openai"
                ? t("llm.protocolShortOpenai")
                : t("llm.protocolShortAnthropic")}
              {" · "}
              {p.model || "—"}
              {p.base_url ? ` · ${p.base_url}` : ""}
              {p.api_key_hint ? ` · ${t("llm.keyHint", { hint: p.api_key_hint })}` : ` · ${t("llm.keyEmpty")}`}
            </div>
          </div>
        ))}
      </div>

      {/* ---- 调用设置 ---- */}
      <div style={{ fontSize: 12, fontWeight: 600, margin: "16px 0 6px" }}>
        {t("llm.settingsTitle")}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("llm.timeout")}</label>
        <input
          value={timeoutSec}
          inputMode="numeric"
          onChange={(e) => setTimeoutSec(e.target.value)}
        />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("llm.timeoutHint")}
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("llm.retries")}</label>
        <input
          value={retries}
          inputMode="numeric"
          onChange={(e) => setRetries(e.target.value)}
        />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("llm.retriesHint")}
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("llm.autoSelect")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          {[true, false].map((v) => (
            <button
              key={String(v)}
              className={autoSelect === v ? "primary" : ""}
              style={{ fontSize: 11 }}
              onClick={() => setAutoSelect(v)}
            >
              {v ? t("llm.autoSelectOn") : t("llm.autoSelectOff")}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("llm.autoSelectHint")}
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("llm.budget")}</label>
        <input
          value={budget}
          inputMode="decimal"
          onChange={(e) => setBudget(e.target.value)}
          placeholder={t("llm.budgetPh", {
            def:
              llmConfig?.global_budget_usd == null
                ? "—"
                : llmConfig.global_budget_usd === 0
                  ? t("llm.budgetUnlimited")
                  : `$${llmConfig.global_budget_usd}`,
          })}
        />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("llm.budgetHint")}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="primary" style={{ fontSize: 12 }} disabled={busy} onClick={submitSettings}>
          {t("llm.save")}
        </button>
        {llmConfig?.configured && (
          <button style={{ fontSize: 12 }} disabled={busy} onClick={() => void run(async () => {
            await clearLlmConfig();
          }, t("llm.resetOk"))}>
            {t("llm.reset")}
          </button>
        )}
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7, marginTop: 10 }}>
        {t("llm.note")}
        <br />
        {t("llm.state")}
        {llmConfig?.configured ? t("llm.own") : t("llm.serverDefault")}
        {msg && <div style={{ marginTop: 4, color: "var(--accent)" }}>{msg}</div>}
      </div>
    </>
  );
}
