import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useStore } from "../../store";
import { dirname } from "../../store/actions/viewer";
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

/** 路径比较键：分隔符/尾分隔符/大小写归一（Windows 的 \
    与不敏感盘；dirname 原文切片 vs listDir 的 path.join
    返回值分隔符可能不同）。仅用于比较，不做键展示。 */
const norm = (p: string): string =>
  p.replace(/[/\\]+/g, "/").replace(/\/$/, "").toLowerCase();

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
  const activePath = useStore((s) => s.viewer.tabs.find((x) => x.id === s.viewer.activeId)?.path ?? null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const st = useDir(dir);

  const toggle = (p: string): void =>
    setExpandedDirs((m) => ({ ...m, [norm(p)]: !m[norm(p)] }));

  // tab 跟随（与侧栏会话列表同款）：活动文件落在子目录里
  // 而该目录被折叠时，强制展开把它露出来。展开状态仍是
  // 本地 state——手动收起依然有效（下次 tab 再切回来才会再展开）。
  // 比较 / 键统一按分隔符归一（listDir 返回 path.join 的
  // 原生分隔符，dirname 是原文切片，Windows 上可能混用）。
  useEffect(() => {
    if (!activePath) return;
    const self = norm(dir);
    // 逐级向上的目录链，若有一级就是本层可见条目之一。
    let seg = dirname(activePath);
    const chain: string[] = [];
    while (seg && norm(seg) !== self && norm(seg).length > self.length) {
      chain.push(seg);
      seg = dirname(seg);
    }
    if (!seg || norm(seg) !== self) return; // 活动文件不在本目录子树
    setExpandedDirs((m) => {
      let changed = false;
      const next = { ...m };
      for (const p of chain) {
        const k = norm(p);
        if (!next[k]) {
          next[k] = true;
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, [activePath, dir, st.entries, norm]);

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
              className={`vtree-row file ${activePath && norm(e.path) === norm(activePath) ? "active" : ""}`}
              data-vtree-row={e.path}
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
  const activePath = useStore((s) => s.viewer.tabs.find((x) => x.id === s.viewer.activeId)?.path ?? null);
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

  // tab 跟随的树根侧：活动文件的目录不是当前树根（含其
  // 子目录）时，把树根挪到活动文件所在目录——与「树根跟随
  // 最近打开文件」的既有行为一致，只是切 tab（而非新开文件）
  // 也会跟随。根对了之后，深处的目录由 DirRows 的强制展开接管。
  useEffect(() => {
    if (!activePath || !treeRoot) return;
    const dir = dirname(activePath);
    if (!dir || dir === treeRoot) return;
    if ((norm(dir) + "/").startsWith(norm(treeRoot) + "/")) return; // 树已对着，只差展开
    useStore.setState((s) => ({ viewer: { ...s.viewer, treeRoot: dir } }));
  }, [activePath, treeRoot]);

  // tab 跟随的滚动侧：找活动文件行滚进视野（找不到 =
  // 文件还没被展开出来或不在树上，跳过）。目录列表走 IPC
  // 异步加载，行未必在下一帧就出现：最多等 20 帧（约 300ms，
  // 懒加载目录链逐层展开也要时间），行出现即滚、到点放弃。
  useEffect(() => {
    if (!activePath) return;
    const cssStr = activePath.replace(/(["\\])/g, "\\$1");
    const sel = `[data-vtree-row="${cssStr}"]`;
    let n = 0;
    let raf = 0;
    const tick = (): void => {
      const row = document.querySelector<HTMLElement>(sel);
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        return;
      }
      if (++n < 20) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activePath, treeRoot]);

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
