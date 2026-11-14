// viewer:// URL 拼装（renderer 侧）。整条路径放 pathname、host 固定
// "local"——Windows 盘符冒号不能进 host（host 里 : 是端口分隔符），
// 逐段 encodeURIComponent 让斜杠保持分段、空格/中文安全编码。
// main 侧 viewer.ts 的 pathFromViewerUrl 对应解码。

/** 本机绝对路径 → viewer:// URL。 */
export function toViewerUrl(absPath: string): string {
  const segs = absPath
    .split(/[/\\]/)
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg));
  const pathname = `/${segs.join("/")}`;
  return `viewer://local${pathname}`;
}
