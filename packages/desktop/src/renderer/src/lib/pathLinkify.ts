// 路径 linkify：把纯文本里的本机绝对路径转成可点 chip（点击
// 经 viewer.stat 校验存在再进阅读器——避免误报路径弹出空 tab）。
// 保守正则：绝对路径、最后一段含点（有扩展名）、无空白、≤400 字符。
// 供两处共用：助手 Markdown 正文（chat/markdown.tsx）、工具结果
// 纯文本（MessageBlock 的 ToolResult）——聊天里提到/生成的文件
// 路径一律优先进内置阅读器。

import type React from "react";

/** 命中返回非空则该文本节点整体跳过（不 linkify）。 */
export type SkipFn = (el: HTMLElement) => string | null;

const PATH_RE =
  /(?:[A-Za-z]:\\|\/)[^\s<>"""'）)\]}。，、！？；：]+/g;

function looksLikePath(s: string): boolean {
  if (s.length > 400) return false;
  const last = s.split(/[\\/]/).pop() ?? "";
  return last.includes(".") && !/\s/.test(last);
}

export function linkifyPaths(
  root: HTMLElement,
  onOpen: (paths: string[]) => void,
  skip?: SkipFn,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; hits: { start: number; end: number }[] }[] = [];
  let cur: Text | null;
  while ((cur = walker.nextNode() as Text | null)) {
    const text = cur.nodeValue ?? "";
    if (text.length < 4) continue;
    // 代码块/已有链接/调用方要求跳过的容器不动。
    const parent = cur.parentElement;
    if (!parent || parent.closest("a, code, pre, .path-chip")) continue;
    if (skip && skip(parent)) continue;
    const hits: { start: number; end: number }[] = [];
    PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_RE.exec(text)) !== null) {
      // 模糊尾段：正则吃进了尾部标点时剥掉（中文标点已在字符类外）。
      const hit = m[0].replace(/[-._]+$/, "");
      if (!looksLikePath(hit)) continue;
      hits.push({ start: m.index, end: m.index + hit.length });
    }
    if (hits.length > 0) targets.push({ node: cur, hits });
  }
  for (const { node, hits } of targets) {
    const text = node.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const { start, end } of hits) {
      if (start > pos) frag.appendChild(document.createTextNode(text.slice(pos, start)));
      const chip = document.createElement("span");
      chip.className = "path-chip";
      chip.setAttribute("data-path", text.slice(start, end));
      chip.textContent = text.slice(start, end);
      frag.appendChild(chip);
      pos = end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  }
  // 委托点击：建 chip 时不挂监听（无注入面——data 属性只由本
  // 函数写入），容器统一接管。
  if (targets.length > 0) root.classList.add("md-linkified");
}

/** chip 点击统一处理：stat 校验 → 进阅读器 / 报「文件不存在」。 */
export function handleChipClick(
  e: React.MouseEvent,
  onOpen: (paths: string[]) => void,
  missingMsg: string,
): boolean {
  const chip = (e.target as HTMLElement).closest("span.path-chip");
  if (!chip) return false;
  e.preventDefault();
  const p = chip.getAttribute("data-path");
  if (!p) return true;
  void window.blm.viewer.stat(p).then((r) => {
    if (r.kind === "file" || r.kind === "dir") {
      onOpen([p]);
    } else {
      // 延迟 import 避免与 store 成环。
      import("../store").then(({ useStore }) =>
        useStore.setState({ error: missingMsg }),
      );
    }
  });
  return true;
}
