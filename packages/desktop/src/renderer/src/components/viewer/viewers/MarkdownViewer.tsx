import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n";
import { Markdown } from "../../chat/markdown";
import type { ViewerProps } from "../registry";
import { fmtBytes } from "./TextViewer";
import { toViewerUrl } from "../toViewerUrl";
import { dirname } from "../../../store/actions/viewer";

// Markdown viewer：默认渲染预览（复用聊天同款 marked+DOMPurify），
// 可切「源码」看原文（含截断条）。文档里的相对路径图片/链接
// 重写为 viewer:// 或绝对路径（相对该 md 所在目录解出）。

/** 相对/绝对路径 → 可用资源 URL（相对路径按文档目录解）。 */
function resolveResource(mdDir: string | null, href: string): string {
  // 外链/锚点/已是协议的保持原样。
  if (/^(https?:|viewer:|#|data:|mailto:)/i.test(href)) return href;
  const p = mdDir && !href.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(href)
    ? `${mdDir}/${href}`
    : href;
  // 目录型（以 / 结尾或无扩展名）不可预览，保持路径原样交给 chip。
  return toViewerUrl(p.replace(/[\\/]+$/, ""));
}

export default function MarkdownViewer({ path, name }: ViewerProps): React.JSX.Element {
  const t = useT();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [state, setState] = useState<{
    loading: boolean;
    text: string;
    truncated: boolean;
    totalBytes: number;
    error: string | null;
  }>({ loading: true, text: "", truncated: false, totalBytes: 0, error: null });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, text: "", truncated: false, totalBytes: 0, error: null });
    void window.blm.viewer.read(path).then((r) => {
      if (!alive) return;
      if (r.kind === "text") {
        setState({ loading: false, text: r.text, truncated: r.truncated, totalBytes: r.total_bytes, error: null });
      } else if (r.kind === "empty") {
        setState({ loading: false, text: "", truncated: false, totalBytes: 0, error: null });
      } else {
        setState({
          loading: false, text: "", truncated: false, totalBytes: 0,
          error: r.kind === "error" ? r.error : r.kind === "too_large" ? `${fmtBytes(r.size)} > ${fmtBytes(r.max_bytes)}` : t("vw.binary"),
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [path, t]);

  // 预览前把相对资源重写为 viewer:// URL（本文件与文本一起 memo）。
  // 必须在下面的提前 return 之前调用：hook 数量每个渲染都要一致。
  const mdDir = dirname(path);
  const rewritten = useMemo(() => {
    const text = state.text || "";
    // 图片/链接两种 Markdown 语法的 () 目标。
    return text.replace(
      /(!?\[[^\]]*\]\()([^)\s]+)(\))/g,
      (whole, pre: string, href: string, post: string) =>
        href.startsWith("viewer:") || /^(https?:|#|data:|mailto:)/i.test(href)
          ? whole
          : `${pre}${resolveResource(mdDir, href)}${post}`,
    );
  }, [state.text, mdDir]);

  if (state.loading) return <div className="viewer-status">{t("vw.loading")}</div>;
  if (state.error) return <div className="viewer-status">{state.error}</div>;

  return (
    <div className="viewer-md">
      <div className="viewer-md-mode">
        <button
          className={mode === "preview" ? "active" : ""}
          onClick={() => setMode("preview")}
        >
          {t("vw.mdPreview")}
        </button>
        <button
          className={mode === "source" ? "active" : ""}
          onClick={() => setMode("source")}
        >
          {t("vw.mdSource")}
        </button>
        {state.truncated && (
          <span className="viewer-truncated inline">
            {t("vw.truncated", { size: fmtBytes(state.totalBytes) })}
          </span>
        )}
      </div>
      {mode === "preview" ? (
        <div className="viewer-md-body"><Markdown text={rewritten} /></div>
      ) : (
        <pre className="viewer-text" title={name}>{state.text}</pre>
      )}
    </div>
  );
}
