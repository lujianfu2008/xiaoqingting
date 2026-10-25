import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT, type Key } from "../../i18n";

type ScopeMode = AccessScopeState["mode"];

// The work dir + access-scope policy live in the main process (settings.json);
// this panel only reads/patches them over IPC.

const MODE_HINTS: Record<ScopeMode, Key> = {
  workspace: "gen.modeWsHint",
  full: "gen.modeFullHint",
  custom: "gen.modeCustomHint",
};

export function GeneralPanel(): React.JSX.Element {
  const avatarMode = useStore((s) => s.avatarMode);
  const setAvatarMode = useStore((s) => s.setAvatarMode);
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [mode, setMode] = useState<ScopeMode>("workspace");
  const [folders, setFolders] = useState<string[]>([]);
  const [closeAction, setCloseAction] = useState<"quit" | "tray">("quit");
  const t = useT();

  const refreshScope = (): void => {
    void window.blm.accessScope.get().then((s) => {
      setWorkDir(s.workDir);
      setMode(s.mode);
      setFolders(s.folders);
    });
  };

  useEffect(() => {
    refreshScope();
    void window.blm.getPrefs().then((p) => setCloseAction(p.closeAction));
  }, []);

  const changeCloseAction = (v: "quit" | "tray"): void => {
    setCloseAction(v); // optimistic
    void window.blm.setCloseAction(v).then(setCloseAction);
  };

  const changeWorkDir = (): void => {
    void window.blm
      .executeLocalAction({ action: "choose_workdir", params: {} })
      .then(() => refreshScope());
  };

  const changeMode = (mode: ScopeMode): void => {
    void window.blm.accessScope.setMode(mode).then((s) => {
      setMode(s.mode);
      setFolders(s.folders);
    });
  };

  const addFolder = (): void => {
    void window.blm.accessScope.addFolder().then((s) => {
      setMode(s.mode);
      setFolders(s.folders);
    });
  };

  const removeFolder = (folder: string): void => {
    void window.blm.accessScope.removeFolder(folder).then((s) => setFolders(s.folders));
  };

  return (
    <>
      <div className="field">
        <label>{t("gen.workdirLabel")}</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span
            title={workDir ?? undefined}
            style={{ flex: 1, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}
          >
            {workDir ?? t("gen.workdirNone")}
          </span>
          <button style={{ fontSize: 12 }} onClick={changeWorkDir}>
            {t("gen.change")}
          </button>
        </div>
      </div>

      <div className="field">
        <label>{t("gen.scope")}</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
          {(["workspace", "full", "custom"] as const).map((m) => (
            <label key={m} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
              <input
                type="radio"
                name="access-scope"
                checked={mode === m}
                onChange={() => changeMode(m)}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ fontSize: 12 }}>
                  {t(m === "workspace" ? "gen.modeWs" : m === "full" ? "gen.modeFull" : "gen.modeCustom")}
                </span>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                  {t(MODE_HINTS[m])}
                </span>
              </span>
            </label>
          ))}
        </div>
        {mode === "custom" && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {folders.map((f) => (
                <div key={f} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span
                    title={f}
                    style={{ flex: 1, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}
                  >
                    {f}
                  </span>
                  <button style={{ fontSize: 12 }} onClick={() => removeFolder(f)}>
                    {t("gen.remove")}
                  </button>
                </div>
              ))}
              {folders.length === 0 && (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {t("gen.noFolders")}
                </span>
              )}
            </div>
            <button style={{ fontSize: 12, marginTop: 6 }} onClick={addFolder}>
              {t("gen.addFolder")}
            </button>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          {t("gen.scopeNote")}
        </div>
      </div>

      <div className="field">
        <label>{t("gen.close")}</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="radio"
              name="close-action"
              checked={closeAction === "quit"}
              onChange={() => changeCloseAction("quit")}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontSize: 12 }}>{t("gen.closeQuit")}</span>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                {t("gen.closeQuitHint")}
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="radio"
              name="close-action"
              checked={closeAction === "tray"}
              onChange={() => changeCloseAction("tray")}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontSize: 12 }}>{t("gen.closeTray")}</span>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                {t("gen.closeTrayHint")}
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="field">
        <label>{t("gen.browser")}</label>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {t("gen.browserHint")}
        </div>
      </div>

      <div className="field">
        <label>{t("gen.avatar")}</label>
        <select
          value={avatarMode}
          onChange={(e) => setAvatarMode(e.target.value as "dragonfly" | "digitalhuman")}
        >
          <option value="dragonfly">{t("gen.avatarDfly")}</option>
          <option value="digitalhuman">{t("gen.avatarDh")}</option>
        </select>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {avatarMode === "digitalhuman"
            ? t("gen.avatarDhHint")
            : t("gen.avatarDflyHint")}
        </div>
      </div>
    </>
  );
}
