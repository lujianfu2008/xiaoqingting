import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useStore } from "../../store";
import type { ViewerEntry } from "@blm/protocol";

// 阅读器左栏文件树：从当前 tab 文件所在目录开始，单层懒加载
// listDir、点目录展开、`..` 上行。目录展开状态是本地 state
// （不进 store——刷新即忘，符合"顺手看看"定位）。

interface DirState {
  entries: ViewerEntry[];
  hasMore: boolean;
  error: string | null;
  loading: boolean;
}

function useDir(dir: string | null): DirState {
  const [state, setState] = useState<DirState>({ entries: [], hasMore: false, error: null, loading: true });
  useEffect(() => {
    if (!dir) {
      setState({ entries: [], hasMore: false, error: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    void window.blm.viewer.listDir(dir).then((r) => {
      setState({
        entries: r.entries,
        hasMore: r.has_more,
        error: r.error ?? null,
        loading: false,
      });
    });
  }, [dir]);
  return state;
}

/** 一层目录列表（根目录行由父级渲染）。 */
function DirRows({ dir, depth }: { dir: string; depth: number }): React.JSX.Element | null {
  const t = useT();
  const openViewerFiles = useStore((s) => s.openViewerFiles);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const st = useDir(dir);

  const toggle = (p: string): void =>
    setExpandedDirs((m) => ({ ...m, [p]: !m[p] }));

  if (st.loading && st.entries.length === 0) {
    return <div className="vtree-note" style={{ paddingLeft: depth * 14 }}>{t("vw.loading")}</div>;
  }
  if (st.error) {
    return <div className="vtree-note" style={{ paddingLeft: depth * 14 }}>{st.error}</div>;
  }
  if (st.entries.length === 0) {
    return <div className="vtree-note" style={{ paddingLeft: depth * 14 }}>{t("vw.dirEmpty")}</div>;
  }

  return (
    <>
      {st.entries.map((e) => (
        <div key={e.path}>
          {e.is_dir ? (
            <>
              <button
                className="vtree-row dir"
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => toggle(e.path)}
                title={e.path}
              >
                <span className="vtree-caret">{expandedDirs[e.path] ? "▾" : "▸"}</span>
                <span className="vtree-name">📁 {e.name}</span>
              </button>
              {expandedDirs[e.path] && (
                <DirRows dir={e.path} depth={depth + 1} />
              )}
            </>
          ) : (
            <button
              className="vtree-row file"
              style={{ paddingLeft: 8 + depth * 14 + 14 }}
              onClick={() => openViewerFiles([e.path])}
              title={`${e.path} · ${e.size}B`}
            >
              <span className="vtree-caret" />
              <span className="vtree-name">📄 {e.name}</span>
            </button>
          )}
        </div>
      ))}
      {st.hasMore && (
        <div className="vtree-note" style={{ paddingLeft: depth * 14 }}>
          {t("vw.listTruncated")}
        </div>
      )}
    </>
  );
}

export function FileTree(): React.JSX.Element | null {
  const t = useT();
  const treeRoot = useStore((s) => s.viewer.treeRoot);
  // 折叠态进 store：树右缘的宽度拖条要跟着隐藏（不拖折叠的树）。
  const collapsed = useStore((s) => s.viewer.treeCollapsed);
  const setTreeCollapsed = useStore((s) => s.setTreeCollapsed);
  const [upDir, setUpDir] = useState<string | null>(null);

  // 根变化时重算上级目录。
  useEffect(() => {
    if (!treeRoot) {
      setUpDir(null);
      return;
    }
    const m = treeRoot.match(/^(.+)[/\\][^/\\]+$/);
    setUpDir(m ? m[1] : null);
  }, [treeRoot]);

  if (!treeRoot) return null;

  if (collapsed) {
    return (
      <button className="vtree-collapse" onClick={() => setTreeCollapsed(false)} title={t("vw.treeShow")}>
        ▸
      </button>
    );
  }

  return (
    <div className="vtree">
      <div className="vtree-head">
        <span className="vtree-root" title={treeRoot}>
          {treeRoot}
        </span>
        <button className="vtree-fold" onClick={() => setTreeCollapsed(true)} title={t("vw.treeHide")}>
          ◂
        </button>
      </div>
      <div className="vtree-body">
        {upDir && (
          <button
            className="vtree-row dir"
            style={{ paddingLeft: 8 }}
            onClick={() => openDir(upDir)}
            title={upDir}
          >
            <span className="vtree-caret">▸</span>
            <span className="vtree-name">📁 ..</span>
          </button>
        )}
        <DirRows dir={treeRoot} depth={0} />
      </div>
    </div>
  );
}

// `..` 上行：直接换树根（store），子层全部重置。
function openDir(p: string): void {
  useStore.setState((s) => ({
    viewer: { ...s.viewer, treeRoot: p },
  }));
}
