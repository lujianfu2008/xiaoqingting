import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT, type Key } from "../../i18n";
import { CODE_THEMES, applyCodeTheme, loadCodeTheme, saveCodeTheme } from "../viewer/codeTheme";
import { UI_THEMES, loadUiTheme, saveUiTheme, applyUiTheme } from "../theme/uiTheme";

type ScopeMode = AccessScopeState["mode"];

// The work dir + access-scope policy live in the main process (settings.json);
// this panel only reads/patches them over IPC.

const MODE_HINTS: Record<ScopeMode, Key> = {
  workspace: "gen.modeWsHint",
  full: "gen.modeFullHint",
  custom: "gen.modeCustomHint",
};

/** 字节数 → 人类可读（下载速度显示用）。 */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB/s`;
  return `${n}B/s`;
}

export function GeneralPanel(): React.JSX.Element {
  const avatarMode = useStore((s) => s.avatarMode);
  const setAvatarMode = useStore((s) => s.setAvatarMode);
  const avatarVisible = useStore((s) => s.avatarVisible);
  const setAvatarVisible = useStore((s) => s.setAvatarVisible);
  const notifyEnabled = useStore((s) => s.notifyEnabled);
  const setNotifyEnabled = useStore((s) => s.setNotifyEnabled);
  const viewerAutoOpen = useStore((s) => s.viewerAutoOpen);
  const setViewerAutoOpen = useStore((s) => s.setViewerAutoOpen);
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [mode, setMode] = useState<ScopeMode>("workspace");
  const [folders, setFolders] = useState<string[]>([]);
  const [closeAction, setCloseAction] = useState<"quit" | "tray">("quit");
  // 手动检查更新的就地反馈（无新版/发现新版/失败）。
  const [updateState, setUpdateState] = useState<
    "idle" | "checking" | "none" | "found" | "error"
  >("idle");
  // 自动更新下载进度（主进程节流推送；null = 没有下载在进行）。
  const [dlProgress, setDlProgress] = useState<{
    phase: "idle" | "downloading" | "downloaded";
    percent: number;
    transferred?: number;
    total?: number;
    bytesPerSecond?: number;
  } | null>(null);
  useEffect(
    () =>
      window.blm.onUpdateProgress((s) =>
        setDlProgress(s.phase === "idle" ? null : s),
      ),
    [],
  );
  // 界面语言（初始值取主进程已解析语言；选「跟随系统」后按原始选择显示）。
  const [lang, setLang] = useState<"system" | "zh-CN" | "en">("zh-CN");
  // 代码高亮主题（阅读器源码配色，官方模板清单）。
  const [codeTheme, setCodeTheme] = useState(loadCodeTheme);
  // 界面主题（整窗配色，见 styles/themes.css）。
  const [uiTheme, setUiTheme] = useState(loadUiTheme);
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
    void window.blm.getLanguage().then((l) => setLang(l === "en" ? "en" : "zh-CN"));
  }, []);

  const changeLang = (v: "system" | "zh-CN" | "en"): void => {
    setLang(v);
    // 主进程持久化 + 重建菜单 + 广播 lang-changed（App.tsx 已监听并即时生效）。
    void window.blm.setLanguage(v);
  };

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
        <label>{t("gen.lang")}</label>
        <select
          value={lang}
          onChange={(e) => changeLang(e.target.value as "system" | "zh-CN" | "en")}
        >
          <option value="system">{t("gen.langSystem")}</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("gen.langHint")}
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
        <label
          style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={avatarVisible}
            onChange={(e) => setAvatarVisible(e.target.checked)}
          />
          <span style={{ fontSize: 12 }}>{t("gen.avatarShow")}</span>
        </label>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("gen.avatarShowHint")}
        </div>
      </div>

      <div className="field">
        <label>{t("gen.notify")}</label>
        <label
          style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={notifyEnabled}
            onChange={(e) => setNotifyEnabled(e.target.checked)}
          />
          <span style={{ fontSize: 12 }}>{t("gen.notify")}</span>
        </label>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("gen.notifyHint")}
        </div>
      </div>

      <div className="field">
        <label>{t("vw.autoOpen")}</label>
        <label
          style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={viewerAutoOpen}
            onChange={(e) => setViewerAutoOpen(e.target.checked)}
          />
          <span style={{ fontSize: 12 }}>{t("vw.autoOpen")}</span>
        </label>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("vw.autoOpenHint")}
        </div>
      </div>

      <div className="field">
        <label>{t("gen.uiTheme")}</label>
        <select
          value={uiTheme}
          onChange={(e) => {
            const id = e.target.value;
            setUiTheme(id); // 换变量即换配色，先落 UI 再写存储
            saveUiTheme(id);
            applyUiTheme(id);
          }}
        >
          {UI_THEMES.map((th) => (
            <option key={th.id} value={th.id}>
              {t(th.labelKey)}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("gen.uiThemeHint")}
        </div>
      </div>

      <div className="field">
        <label>{t("gen.codeTheme")}</label>
        <select
          value={codeTheme}
          onChange={(e) => {
            const id = e.target.value;
            setCodeTheme(id); // 模板加载很快，先落 UI 再注入
            saveCodeTheme(id);
            void applyCodeTheme(id);
          }}
        >
          {CODE_THEMES.map((th) => (
            <option key={th.id} value={th.id}>
              {th.label}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("gen.codeThemeHint")}
        </div>
      </div>

      <div className="field">
        <label>{t("gen.updateCheck")}</label>
        {/* 手动重查一次：没有新版就地提示；发现新版后台继续
            下载，下载中显示进度条（主进程节流推送），完成走
            主进程弹窗（不在这里打断）。 */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          <button
            disabled={updateState === "checking"}
            onClick={() => {
              setUpdateState("checking");
              window.blm
                .checkUpdate()
                .then((r) => setUpdateState(r === "available" ? "found" : r === "up_to_date" ? "none" : "error"))
                .catch(() => setUpdateState("error"));
            }}
          >
            {updateState === "checking" ? t("gen.updateChecking") : t("gen.updateCheck")}
          </button>
          {updateState === "none" && (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("gen.updateNone")}</span>
          )}
          {updateState === "error" && (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {t("gen.updateError")}
            </span>
          )}
        </div>
        {dlProgress && (
          <div style={{ marginTop: 8 }}>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "var(--border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${dlProgress.phase === "downloaded" ? 100 : dlProgress.percent}%`,
                  background: "var(--accent, #4a9eff)",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
              {dlProgress.phase === "downloaded"
                ? t("gen.updateDownloaded")
                : t("gen.updateDownloading", {
                    percent: dlProgress.percent.toFixed(0),
                    speed: dlProgress.bytesPerSecond
                      ? formatBytes(dlProgress.bytesPerSecond)
                      : "—",
                  })}
            </div>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("gen.updateNoneHint")}
        </div>
      </div>
    </>
  );
}
