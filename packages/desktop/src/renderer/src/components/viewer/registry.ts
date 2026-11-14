import type { ComponentType } from "react";

// 扩展名 → 阅读器种类映射 + 按需动态 import。
// 每个 viewer 都是独立 chunk（`() => import(...)`），核心壳
// 不背任何格式解析依赖。未知扩展名不直接放弃：先按文本
// 试读（main 侧嗅探编码，解不动才判 binary），保证所有
// 文本类文件都能在内置阅读器里打开；真二进制在
// TextViewer 里给出「用系统打开」逃生口。

export type ViewerKind =
  | "text" // 纯文本（log/csv/toml 等，直接 <pre>，不高亮）
  | "code" // 源码（语法高亮，highlight.js common）
  | "markdown" // Markdown 渲染（源码/预览切换）
  | "json" // JSON 可折叠树
  | "image"
  | "media" // 音视频（viewer:// 流 + Range 拖进度）
  | "pdf" // pdfjs 逐页渲染
  | "unknown"; // 无法判定 → 兜底页（系统打开）

// 源码扩展名（语法高亮）：java/python/sql/js/ts 等常用全含——
// highlight.js common 捆的语言表是权威，这里只列扩展名。
const CODE_EXTS = new Set([
  // java 系
  "java", "kt", "kts", "scala", "groovy", "gradle",
  // python 系
  "py", "pyw", "pyi", "ipynb" /* 下放 code（json 树差）—ipython notebook 结构 json 仍是 json */,
  // web / js 系
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "html", "htm", "css", "scss", "less",
  // C 系
  "c", "h", "cpp", "hpp", "cc", "cxx", "cs", "swift", "m", "mm",
  // 其它常用
  "go", "rs", "rb", "php", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "lua", "r", "pl", "dart", "asm", "sql",
  // 配置/标记
  "xml", "yaml", "yml", "ini", "cfg", "conf", "properties",
  "dockerfile", "makefile", "cmake", "protobuf", "proto", "graphql",
]);

// 「确定是纯文本」的扩展名（其余未知扩展名也按文本
// 试读，见 kindOf 尾部注释——binary 嗅探兜底）。
const TEXT_PLAIN = new Set([
  "txt", "log", "csv", "tsv", "env", "gitignore", "lock", "plist",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
const MEDIA_EXTS = new Set(["mp4", "webm", "mkv", "mov", "mp3", "wav", "ogg", "m4a", "flac"]);
const PDF_EXTS = new Set(["pdf"]);

/** 扩展名（不含点）→ 阅读器种类。 */
export function kindOf(name: string): ViewerKind {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  // 无扩展名但文件名就是构建/脚本惯例名的，按 code 走高亮。
  const base = name.toLowerCase();
  if (CODE_EXTS.has(ext) || base === "dockerfile" || base === "makefile" || base === "cmakelists.txt") {
    return "code";
  }
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MEDIA_EXTS.has(ext)) return "media";
  if (PDF_EXTS.has(ext)) return "pdf";
  // 文本类（已知纯文本扩展名）与一切未知扩展名都先按
  // 文本读：嗅探判 binary 后仍有系统打开兜底，不会
  // 把真二进制硬塞给用户。
  return "text";
}

export interface ViewerProps {
  path: string;
  name: string;
}

type Loader = () => Promise<{ default: ComponentType<ViewerProps> }>;

const LAZY: Partial<Record<ViewerKind, Loader>> = {
  text: () => import("./viewers/TextViewer"),
  code: () => import("./viewers/CodeViewer"),
  markdown: () => import("./viewers/MarkdownViewer"),
  json: () => import("./viewers/JsonViewer"),
  image: () => import("./viewers/MediaViewer"),
  media: () => import("./viewers/MediaViewer"),
  pdf: () => import("./viewers/PdfViewer"),
  unknown: () => import("./viewers/UnknownViewer"),
};

/** 按需加载一个 viewer 组件（unknown 无组件 → null）。 */
export function loadViewer(kind: ViewerKind): Promise<ComponentType<ViewerProps> | null> {
  const loader = LAZY[kind];
  if (!loader) return Promise.resolve(null);
  return loader().then((m) => m.default).catch(() => null);
}
