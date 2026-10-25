import { useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

type ScopeMode = AccessScopeState["mode"];

// New-project dialog: name + one of the three agent roles + how to pick the
// local folder that becomes the project's independent space on this machine,
// plus the project's read-scope (defaults to following the global setting).
export function NewProjectDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const agents = useStore((s) => s.agents);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const createProject = useStore((s) => s.createProject);
  const role = useStore((s) => s.role);

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(currentAgentId);
  const [folder, setFolder] = useState<"auto" | "choose">("auto");
  // 公有域项目：存服务端工作空间，全员可查；仅管理员可创建。
  const [isPublic, setIsPublic] = useState(false);
  const [scope, setScope] = useState<"global" | ScopeMode>("global");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const project = await createProject({
      name: name.trim(),
      agentId,
      folder: isPublic ? "auto" : folder,
      visibility: isPublic ? "public" : "personal",
    });
    if (!project) {
      setBusy(false);
      setErr(t("np.fail"));
      return;
    }
    if (!isPublic && scope !== "global") {
      await window.blm.accessScope.setProjectMode(project.project_id, scope);
    }
    setBusy(false);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <h2>{t("np.title")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "4px 0 12px" }}>
          {t("np.desc")}
        </p>

        <div className="field">
          <label>{t("np.name")}</label>
          <input
            autoFocus
            value={name}
            placeholder={t("np.namePh")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>

        <div className="field">
          <label>{t("np.agent")}</label>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.name} — {a.description}
              </option>
            ))}
            {agents.length === 0 && <option value={agentId}>{t("side.defaultAgent")}</option>}
          </select>
        </div>

        {role === "admin" && (
          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
              />
              {t("np.public")}
            </label>
            {isPublic && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                {t("np.publicTip")}
              </div>
            )}
          </div>
        )}

        {!isPublic && (
        <>
        <div className="field">
          <label>{t("np.folder")}</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="radio"
              checked={folder === "auto"}
              onChange={() => setFolder("auto")}
            />
            {t("np.folderAuto")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <input
              type="radio"
              checked={folder === "choose"}
              onChange={() => setFolder("choose")}
            />
            {t("np.folderChoose")}
          </label>
        </div>

        <div className="field">
          <label>{t("np.scope")}</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="global">{t("np.scopeGlobal")}</option>
            <option value="workspace">{t("np.scopeWs")}</option>
            <option value="full">{t("np.scopeFull")}</option>
            <option value="custom">{t("np.scopeCustom")}</option>
          </select>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            {t("np.scopeHint")}
          </div>
        </div>
        </>
        )}

        {err && (
          <div style={{ color: "#e56", fontSize: 12, margin: "0 0 8px" }}>{err}</div>
        )}

        <div className="actions">
          <button onClick={onClose} disabled={busy}>
            {t("np.cancel")}
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {t("np.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
