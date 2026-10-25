import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

export function LlmPanel(): React.JSX.Element {
  const llmConfig = useStore((s) => s.llmConfig);
  const saveLlmConfig = useStore((s) => s.saveLlmConfig);
  const clearLlmConfig = useStore((s) => s.clearLlmConfig);
  const [llmKey, setLlmKey] = useState("");
  const [llmBase, setLlmBase] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmMsg, setLlmMsg] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    setLlmBase(llmConfig?.base_url ?? "");
    setLlmModel(llmConfig?.model ?? "");
  }, [llmConfig]);

  const submitLlm = async (): Promise<void> => {
    setLlmBusy(true);
    setLlmMsg(null);
    try {
      await saveLlmConfig({
        api_key: llmKey.trim() || undefined,
        base_url: llmBase.trim() || undefined,
        model: llmModel.trim() || undefined,
      });
      setLlmKey("");
      setLlmMsg(t("llm.saved"));
    } catch (e) {
      setLlmMsg(e instanceof Error ? e.message : t("llm.saveFail"));
    } finally {
      setLlmBusy(false);
    }
  };

  const resetLlm = async (): Promise<void> => {
    setLlmBusy(true);
    setLlmMsg(null);
    try {
      await clearLlmConfig();
      setLlmKey("");
      setLlmMsg(t("llm.resetOk"));
    } catch (e) {
      setLlmMsg(e instanceof Error ? e.message : t("llm.resetFail"));
    } finally {
      setLlmBusy(false);
    }
  };

  return (
    <>
      <div className="field">
        <label>API Key</label>
        <input
          type="password"
          value={llmKey}
          onChange={(e) => setLlmKey(e.target.value)}
          placeholder={
            llmConfig?.api_key_hint
              ? t("llm.keyPhConfigured", { hint: llmConfig.api_key_hint })
              : t("llm.keyPhNone")
          }
        />
      </div>

      <div className="field">
        <label>{t("llm.baseUrl")}</label>
        <input
          value={llmBase}
          onChange={(e) => setLlmBase(e.target.value)}
          placeholder={t("llm.baseUrlPh")}
        />
      </div>

      <div className="field">
        <label>{t("llm.model")}</label>
        <input
          value={llmModel}
          onChange={(e) => setLlmModel(e.target.value)}
          placeholder={t("llm.modelPh")}
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="primary"
          style={{ fontSize: 12 }}
          disabled={llmBusy}
          onClick={() => void submitLlm()}
        >
          {t("llm.save")}
        </button>
        {llmConfig?.configured && (
          <button style={{ fontSize: 12 }} disabled={llmBusy} onClick={() => void resetLlm()}>
            {t("llm.reset")}
          </button>
        )}
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
        {t("llm.note")}
        <br />
        {t("llm.state")}
        {llmConfig?.configured ? t("llm.own") : t("llm.serverDefault")}
        {llmMsg && <div style={{ marginTop: 4, color: "var(--accent)" }}>{llmMsg}</div>}
      </div>
    </>
  );
}
