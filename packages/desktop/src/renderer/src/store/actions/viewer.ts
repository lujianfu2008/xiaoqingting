import type { BlmState, GetState, SetState } from "../types";

// 内置文件阅读器：多 tab、只读。openViewerFiles 按 path 去重
// （已开的直接激活），treeRoot 取新文件的目录。关掉最后一个 tab
// 时整个 pane 收起。

export function createViewerActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "openViewerFiles"
  | "closeViewerTab"
  | "activateViewerTab"
  | "setViewerOpen"
  | "setViewerAutoOpen"
  | "setTreeCollapsed"
> {
  return {
    openViewerFiles(paths) {
      if (paths.length === 0) return;
      const cur = get().viewer;
      const tabs = [...cur.tabs];
      let last: string | null = cur.activeId;
      for (const p of paths) {
        const name = p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? p;
        const existing = tabs.find((x) => x.path === p);
        if (existing) {
          last = existing.id;
          continue;
        }
        const tab = {
          id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          path: p,
          name,
          size: 0,
        };
        tabs.push(tab);
        last = tab.id;
      }
      if (!last) return;
      const active = tabs.find((x) => x.id === last)!;
      set({
        viewer: {
          open: true,
          tabs,
          activeId: last,
          // 文件浏览树从新打开文件的目录开始。
          treeRoot: dirname(active.path) ?? cur.treeRoot,
          treeCollapsed: cur.treeCollapsed,
        },
      });
    },

    closeViewerTab(id) {
      const cur = get().viewer;
      const idx = cur.tabs.findIndex((x) => x.id === id);
      if (idx < 0) return;
      const tabs = cur.tabs.filter((x) => x.id !== id);
      if (tabs.length === 0) {
        // 最后一个 tab 关掉 = 整个 pane 收起。
        set({ viewer: { open: false, tabs: [], activeId: null, treeRoot: cur.treeRoot, treeCollapsed: cur.treeCollapsed } });
        return;
      }
      const activeId =
        cur.activeId === id ? tabs[Math.min(idx, tabs.length - 1)].id : cur.activeId;
      set({ viewer: { ...cur, tabs, activeId } });
    },

    activateViewerTab(id) {
      const cur = get().viewer;
      if (!cur.tabs.some((x) => x.id === id)) return;
      set({ viewer: { ...cur, activeId: id, open: true } });
    },

    setViewerOpen(on) {
      const cur = get().viewer;
      // 无 tab 时不允许凭空展开（树根也没有着落）。
      if (on && cur.tabs.length === 0) return;
      set({ viewer: { ...cur, open: on } });
    },

    setViewerAutoOpen(on) {
      set({ viewerAutoOpen: on });
      localStorage.setItem("blm.viewerAutoOpen", on ? "1" : "0");
    },

    setTreeCollapsed(on) {
      set({ viewer: { ...get().viewer, treeCollapsed: on } });
    },
  };
}

/** 目录部分（无分隔符返回 null）。 */
export function dirname(p: string): string | null {
  const m = p.match(/^(.+)[/\\][^/\\]+$/);
  return m ? m[1] : null;
}
