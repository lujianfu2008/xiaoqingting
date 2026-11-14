import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { useT } from "../../../i18n";
import type { ViewerProps } from "../registry";
import { applyCodeTheme, loadCodeTheme } from "../codeTheme";
import { fmtBytes } from "./TextViewer";

// 代码 viewer：源码类文件按扩展名选语言做语法高亮
// （highlight.js common 捆 40 种常用语言：java/python/sql/js/ts/
// c/cpp/csharp/go/rust/shell/json/yaml/xml/php/ruby/kotlin/swift/
// dockerfile/makefile/ini 等）。扩展名未命中语言表时退
// highlightAuto 检测，内容过短检测失手时就是普通 <pre>，无害。
// 读取流程与 TextViewer 同款（IPC 文本、编码嗅探、超限逃生口）。
// 配色不写死：主题 = highlight.js 官方 CSS 模板资源，
// 用户在设置里选，挂载时注入（主窗/弹窗各是独立文档）。

const HLJS_LANGS = new Set(hljs.listLanguages());

/** 扩展名 → highlight.js 语言别名（未列出 → undefined 走 auto）。 */
function langOf(name: string): string | undefined {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!ext) return undefined;
  // 扩展名与语言别名不一致的常用格式。
  const alias: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    h: "c",
    hpp: "cpp",
    cc: "cpp",
    yml: "yaml",
    htm: "xml", // hljs 的 xml 语言涵盖 html
    cs: "csharp",
    rb: "ruby",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    py: "python",
    kt: "kotlin",
    kts: "kotlin",
    rs: "rust",
  };
  const lang = alias[ext] ?? ext;
  return HLJS_LANGS.has(lang) ? lang : undefined;
}

export default function CodeViewer({ path, name }: ViewerProps): React.JSX.Element {
  const t = useT();
  const lang = langOf(name);
  // 模板主题：挂载即注入当前选择（localStorage 持久），
  // 注入完成前代码已是无色底色，不阻塞阅读。
  useEffect(() => {
    void applyCodeTheme(loadCodeTheme());
  }, []);
  const [st, setSt] = useState<{
    loading: boolean;
    text: string;
    encoding: string;
    truncated: boolean;
    totalBytes: number;
    empty: boolean;
    tooLarge: { size: number; max: number } | null;
    binary: boolean;
    error: string | null;
  }>({
    loading: true, text: "", encoding: "", truncated: false, totalBytes: 0,
    empty: false, tooLarge: null, binary: false, error: null,
  });

  useEffect(() => {
    let alive = true;
    setSt((s) => ({ ...s, loading: true, error: null }));
    void window.blm.viewer.read(path).then((r) => {
      if (!alive) return;
      if (r.kind === "text") {
        setSt({
          loading: false, text: r.text, encoding: r.encoding, truncated: r.truncated,
          totalBytes: r.total_bytes, empty: false, tooLarge: null, binary: false, error: null,
        });
      } else if (r.kind === "empty") {
        setSt({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: 0,
          empty: true, tooLarge: null, binary: false, error: null,
        });
      } else if (r.kind === "too_large") {
        setSt({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: r.size,
          empty: false, tooLarge: { size: r.size, max: r.max_bytes }, binary: false, error: null,
        });
      } else if (r.kind === "binary") {
        setSt({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: 0,
          empty: false, tooLarge: null, binary: true, error: null,
        });
      } else {
        setSt({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: 0,
          empty: false, tooLarge: null, binary: false, error: r.error,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [path]);

  // 高亮结果与 TextViewer 的 state 同构；language 未命中走 auto。
  const html = useMemo(() => {
    if (!st.text) return "";
    if (lang) {
      return hljs.highlight(st.text, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(st.text).value;
  }, [st.text, lang]);

  const sysOpen = (): void => {
    void window.blm.viewer.openExternal(path).then((r) => {
      if (r?.error) setSt((s) => ({ ...s, error: r.error! }));
    });
  };

  if (st.loading) return <div className="viewer-status">{t("vw.loading")}</div>;
  if (st.empty) return <div className="viewer-status">{t("vw.empty")}</div>;
  if (st.binary) {
    return (
      <div className="viewer-status">
        {t("vw.binary")}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }
  if (st.tooLarge) {
    return (
      <div className="viewer-status">
        {t("vw.tooLarge", {
          size: fmtBytes(st.tooLarge.size),
          max: fmtBytes(st.tooLarge.max),
        })}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }
  if (st.error) {
    return (
      <div className="viewer-status">
        {st.error}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }
  return (
    <>
      {st.truncated && (
        <div className="viewer-truncated">
          {t("vw.truncated", { size: fmtBytes(st.totalBytes) })}
          <button onClick={sysOpen}>{t("vw.openExternal")}</button>
        </div>
      )}
      <pre className="viewer-text code-view" title={name}>
        {/* code.hljs：主题模板的 .hljs{color;background} 才能整体生效
            （只靠 span 会丢块级底色，浅色主题会深底深字）。 */}
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </>
  );
}
