import { useMemo, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useStore } from "../../store";
import { t } from "../../i18n";
import { linkifyPaths, handleChipClick } from "../../lib/pathLinkify";

// 助手消息的 Markdown 渲染：marked 转 HTML 后必须经 DOMPurify 清洗——
// 助手输出是不可信输入，绝不能直接 innerHTML（XSS）。
// breaks: true 让单个换行也断行（聊天习惯，贴近原 pre-wrap 观感）。
const md = new Marked({ gfm: true, breaks: true });

// viewer:// 的 src 一律禁止（收紧本地文件视觉泄露——聊天内容
// 不该有能力把本机图片/视频嵌进消息里）。
const SANITIZE_CFG = { FORBID_ATTR: ["srcset", "src"] as string[] };

function renderMarkdown(text: string): string {
  const html = md.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE_CFG);
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const openViewerFiles = useStore((s) => s.openViewerFiles);

  // 渲染后做路径 linkify（直接 DOM 操作，不走 React 状态）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    linkifyPaths(el, openViewerFiles);
  }, [html, openViewerFiles]);

  return (
    <div
      className="md"
      ref={ref}
      dangerouslySetInnerHTML={{ __html: html }}
      // 链接一律交给系统浏览器开（window.open 走主进程
      // setWindowOpenHandler → shell.openExternal），应用内不跳转。
      onClick={(e) => {
        // 路径 chip：stat 校验后进阅读器（共享工具里处理）。
        if (handleChipClick(e, openViewerFiles, t("vw.fileMissing"))) return;
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        if (href && /^https?:/i.test(href)) {
          window.open(href, "_blank", "noopener");
        }
      }}
    />
  );
}
