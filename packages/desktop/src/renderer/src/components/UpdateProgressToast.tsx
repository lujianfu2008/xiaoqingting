import { useEffect, useState } from "react";
import { useT } from "../i18n";

// 自动更新下载进度浮条：右下角常驻（下载中才出现）。
// 自动检查多发生在登录后、设置面板多半没开——进度必须在
// 主界面任意页面上可见，否则「卡了？在下什么？」完全没感知。
// 下载完成时浮条显示 100% 并让位给主进程的安装确认弹窗。

export function UpdateProgressToast(): React.JSX.Element | null {
  const t = useT();
  const [dl, setDl] = useState<{
    phase: "downloading" | "downloaded";
    percent: number;
    bytesPerSecond?: number;
  } | null>(null);

  useEffect(
    () =>
      window.blm.onUpdateProgress((s) =>
        setDl(s.phase === "idle" ? null : { phase: s.phase, percent: s.percent, bytesPerSecond: s.bytesPerSecond }),
      ),
    [],
  );

  if (!dl) return null;
  const speed = dl.bytesPerSecond
    ? dl.bytesPerSecond >= 1024 * 1024
      ? `${(dl.bytesPerSecond / 1024 / 1024).toFixed(1)}MB/s`
      : `${(dl.bytesPerSecond / 1024).toFixed(0)}KB/s`
    : "";
  return (
    <div
      className="update-toast"
      title={t("gen.updateNoneHint")}
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 260,
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--panel)",
        border: "1px solid var(--border)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        zIndex: 1200,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--muted)" }}>
          {dl.phase === "downloaded"
            ? t("gen.updateToastDone")
            : t("gen.updateToastTitle")}
        </span>
        <span style={{ fontFamily: "ui-monospace, Consolas, monospace" }}>
          {dl.percent.toFixed(0)}%
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          height: 5,
          borderRadius: 2.5,
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${dl.phase === "downloaded" ? 100 : dl.percent}%`,
            background: dl.phase === "downloaded" ? "var(--ok, #4caf50)" : "var(--accent, #4a9eff)",
            transition: "width 0.3s ease",
          }}
        />
      </div>
      {dl.phase === "downloading" && speed && (
        <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 11 }}>{speed}</div>
      )}
    </div>
  );
}
