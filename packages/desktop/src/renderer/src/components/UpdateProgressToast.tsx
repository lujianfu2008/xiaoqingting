import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { LS } from "../store/persist";

// 自动更新下载进度浮条：默认右下角，**可拖动**（位置
// 记 localStorage），带 ✕（取消下载并隐藏浮条——新一轮
// 检查发现新版本时会再出现）。自动检查多发生在登录后、
// 设置面板多半没开——进度必须在主界面任意页面上可见，
// 否则「卡了？在下什么？」完全没感知。下载完成时浮条
// 显示 100% 并让位给主进程的安装确认弹窗。

/** 上次拖到的位置（右/下偏移；null = 默认右下角）。 */
function loadPos(): { right: number; bottom: number } | null {
  try {
    const raw = localStorage.getItem(LS.updateToastPos);
    if (!raw) return null;
    const p = JSON.parse(raw) as { right: number; bottom: number };
    return typeof p.right === "number" && typeof p.bottom === "number" ? p : null;
  } catch {
    return null;
  }
}

export function UpdateProgressToast(): React.JSX.Element | null {
  const t = useT();
  const [dl, setDl] = useState<{
    phase: "downloading" | "downloaded";
    percent: number;
    bytesPerSecond?: number;
  } | null>(null);
  const [pos, setPos] = useState(loadPos);
  // 拖动状态：指针捕捉整拖期间记起点（浮条右/下角与
  // 视口右/下缘的偏移），move 时换算新偏移。lastPos 兜住
  // pointerup 落盘（state 闭包可能差一帧）。
  const drag = useRef<{ startX: number; startY: number; right: number; bottom: number } | null>(null);
  const lastPos = useRef<{ right: number; bottom: number } | null>(pos);
  const [dragging, setDragging] = useState(false);
  const el = useRef<HTMLDivElement>(null);

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

  const clampPos = (right: number, bottom: number) => {
    const w = el.current?.offsetWidth ?? 260;
    const h = el.current?.offsetHeight ?? 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      right: Math.min(Math.max(0, right), vw - w - 8),
      bottom: Math.min(Math.max(0, bottom), vh - h - 8),
    };
  };

  return (
    <div
      ref={el}
      className={`update-toast ${dragging ? "dragging" : ""}`}
      title={t("gen.updateNoneHint")}
      style={{
        position: "fixed",
        right: pos?.right ?? 16,
        bottom: pos?.bottom ?? 16,
        width: 260,
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--panel)",
        border: "1px solid var(--border)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        zIndex: 1200,
        fontSize: 12,
      }}
      // 顶栏做拖把手（进度条/文案照常显示；✕ 停止传播）。
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button")) return;
        const cur = pos ?? {
          right: window.innerWidth - (el.current?.offsetWidth ?? 260) - 16,
          bottom: window.innerHeight - (el.current?.offsetHeight ?? 60) - 16,
        };
        drag.current = { startX: e.clientX, startY: e.clientY, right: cur.right, bottom: cur.bottom };
        lastPos.current = cur;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const p = clampPos(d.right + (d.startX - e.clientX), d.bottom + (d.startY - e.clientY));
        lastPos.current = p;
        setPos(p);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        if (lastPos.current) localStorage.setItem(LS.updateToastPos, JSON.stringify(lastPos.current));
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--muted)" }}>
          {dl.phase === "downloaded"
            ? t("gen.updateToastDone")
            : t("gen.updateToastTitle")}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: "ui-monospace, Consolas, monospace" }}>
            {dl.percent.toFixed(0)}%
          </span>
          {/* ✕：下载中 = 取消下载并收浮条；已完成 = 只收浮条
              （安装确认弹窗仍会来，用户可从那里装）。 */}
          <button
            className="update-toast-x"
            title={t("gen.updateToastClose")}
            onClick={() => {
              window.blm.cancelUpdate();
              setDl(null);
            }}
          >
            ✕
          </button>
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
