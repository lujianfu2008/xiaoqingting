import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n";
import type { ViewerProps } from "../registry";
import { fmtBytes } from "./TextViewer";

// JSON viewer：零依赖可折叠树。parse 失败降级为原文展示。
// 折叠态渲染摘要行，展开递归渲染子节点。

type JNode =
  | { type: "value"; text: string }
  | { type: "array"; items: JNode[] }
  | { type: "object"; entries: [string, JNode][] };

function toNode(v: unknown): JNode {
  if (v === null) return { type: "value", text: "null" };
  if (Array.isArray(v)) return { type: "array", items: v.map(toNode) };
  if (typeof v === "object") {
    return {
      type: "object",
      entries: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toNode(x)]),
    };
  }
  return { type: "value", text: JSON.stringify(v) ?? String(v) };
}

function NodeView({ node, depth }: { node: JNode; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 3);
  const t = useT();
  if (node.type === "value") return <span className="jv-val">{node.text}</span>;
  const isArr = node.type === "array";
  const count = isArr ? node.items.length : node.entries.length;
  return (
    <div className="jv-node">
      <button
        className="jv-toggle"
        onClick={() => setOpen((o) => !o)}
        title={open ? t("vw.jsonCollapse") : t("vw.jsonExpand")}
      >
        {open ? "▾" : "▸"} {isArr ? `[${count}]` : `{${count}}`}
      </button>
      {open ? (
        <div className="jv-children">
          {isArr
            ? node.items.map((x, i) => (
                <div key={i} className="jv-row">
                  <span className="jv-key">{i}</span>
                  <NodeView node={x} depth={depth + 1} />
                </div>
              ))
            : node.entries.map(([k, x]) => (
                <div key={k} className="jv-row">
                  <span className="jv-key">{k}</span>
                  <NodeView node={x} depth={depth + 1} />
                </div>
              ))}
        </div>
      ) : null}
    </div>
  );
}

export default function JsonViewer({ path }: ViewerProps): React.JSX.Element {
  const t = useT();
  const [state, setState] = useState<{
    loading: boolean;
    text: string;
    node: JNode | null;
    truncated: boolean;
    totalBytes: number;
    error: string | null;
  }>({ loading: true, text: "", node: null, truncated: false, totalBytes: 0, error: null });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    void window.blm.viewer.read(path).then((r) => {
      if (!alive) return;
      if (r.kind === "text") {
        let node: JNode | null = null;
        try {
          node = toNode(JSON.parse(r.text) as unknown);
        } catch {
          // parse 失败 → 原文展示
        }
        setState({ loading: false, text: r.text, node, truncated: r.truncated, totalBytes: r.total_bytes, error: null });
      } else if (r.kind === "empty") {
        setState({ loading: false, text: "", node: null, truncated: false, totalBytes: 0, error: null });
      } else {
        setState({
          loading: false, text: "", node: null, truncated: false, totalBytes: 0,
          error: r.kind === "error" ? r.error : r.kind === "too_large" ? `${fmtBytes(r.size)} > ${fmtBytes(r.max_bytes)}` : t("vw.binary"),
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [path, t]);

  const body = useMemo(() => {
    if (state.node) return <NodeView node={state.node} depth={0} />;
    return <pre className="viewer-text">{state.text}</pre>;
  }, [state.node, state.text]);

  if (state.loading) return <div className="viewer-status">{t("vw.loading")}</div>;
  if (state.error) return <div className="viewer-status">{state.error}</div>;
  return (
    <>
      {state.truncated && (
        <div className="viewer-truncated">
          {t("vw.truncated", { size: fmtBytes(state.totalBytes) })}
        </div>
      )}
      <div className="viewer-json">{body}</div>
    </>
  );
}
