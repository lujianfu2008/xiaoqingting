import { useEffect, useState } from "react";
import { useT } from "../../../i18n";
import type { ViewerProps } from "../registry";

// 纯文本 viewer：读 IPC 文本（嗅探编码 main 做），超限给
// 「用系统打开」逃生口。二进制判定同样落这里兜底。

export default function TextViewer({ path, name }: ViewerProps): React.JSX.Element {
  const t = useT();
  const [state, setState] = useState<{
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
    setState((s) => ({ ...s, loading: true, error: null }));
    void window.blm.viewer.read(path).then((r) => {
      if (!alive) return;
      if (r.kind === "text") {
        setState({
          loading: false, text: r.text, encoding: r.encoding, truncated: r.truncated,
          totalBytes: r.total_bytes, empty: false, tooLarge: null, binary: false, error: null,
        });
      } else if (r.kind === "empty") {
        setState({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: 0,
          empty: true, tooLarge: null, binary: false, error: null,
        });
      } else if (r.kind === "too_large") {
        setState({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: r.size,
          empty: false, tooLarge: { size: r.size, max: r.max_bytes }, binary: false, error: null,
        });
      } else if (r.kind === "binary") {
        setState({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: 0,
          empty: false, tooLarge: null, binary: true, error: null,
        });
      } else {
        setState({
          loading: false, text: "", encoding: "", truncated: false, totalBytes: 0,
          empty: false, tooLarge: null, binary: false, error: r.error,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [path]);

  const sysOpen = (): void => {
    void window.blm.viewer.openExternal(path).then((r) => {
      if (r?.error) setState((s) => ({ ...s, error: r.error! }));
    });
  };

  if (state.loading) return <div className="viewer-status">{t("vw.loading")}</div>;
  if (state.empty) return <div className="viewer-status">{t("vw.empty")}</div>;
  if (state.binary) {
    return (
      <div className="viewer-status">
        {t("vw.binary")}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }
  if (state.tooLarge) {
    return (
      <div className="viewer-status">
        {t("vw.tooLarge", {
          size: fmtBytes(state.tooLarge.size),
          max: fmtBytes(state.tooLarge.max),
        })}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="viewer-status">
        {state.error}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }
  return (
    <>
      {state.truncated && (
        <div className="viewer-truncated">
          {t("vw.truncated", { size: fmtBytes(state.totalBytes) })}
          <button onClick={sysOpen}>{t("vw.openExternal")}</button>
        </div>
      )}
      <pre className="viewer-text" title={name}>{state.text}</pre>
    </>
  );
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
