import type { BlmState, GetState, SetState } from "../types";

// 内置文件阅读器：多 tab、只读。openViewerFiles 按 path 去重
// （已开的直接激活），treeRoot 取新文件的目录。关掉最后一个 tab
// 时整个 pane 收起。用户手动关（closeViewerTab 关空 / closeViewerAll）
// 会置 viewerAutoSuppressed：本轮内 agent 读写文件不再自动弹出，
// 下一条用户消息重新武装（chat.ts 的 send/regenerate）。

export function createViewerActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "openViewerFiles"
  | "closeViewerTab"
  | "closeViewerAll"
  | "closeViewerOthers"
  | "closeViewerLeft"
  | "closeViewerRight"
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
        // 手动点开文件 = 用户想看了，解除本轮的自动弹出暂停。
        viewerAutoSuppressed: false,
      });
    },

    closeViewerTab(id) {
      const cur = get().viewer;
      const idx = cur.tabs.findIndex((x) => x.id === id);
      if (idx < 0) return;
      const tabs = cur.tabs.filter((x) => x.id !== id);
      if (tabs.length === 0) {
        // 最后一个 tab 关掉 = 整个 pane 收起。
        set({
          viewer: { open: false, tabs: [], activeId: null, treeRoot: cur.treeRoot, treeCollapsed: cur.treeCollapsed },
          // 关掉全部内容视为用户不想被打扰（自动弹出的也在此打断）。
          viewerAutoSuppressed: true,
        });
        return;
      }
      const activeId =
        cur.activeId === id ? tabs[Math.min(idx, tabs.length - 1)].id : cur.activeId;
      set({ viewer: { ...cur, tabs, activeId } });
    },

    /** 总关闭：一键关掉所有 tab 并收起 pane。 */
    closeViewerAll() {
      const cur = get().viewer;
      set({
        viewer: { open: false, tabs: [], activeId: null, treeRoot: cur.treeRoot, treeCollapsed: cur.treeCollapsed },
        viewerAutoSuppressed: true,
      });
    },

    /** 关掉指定 tab 以外的全部（tab 栏右键菜单「关闭其他」；
     *  保留目标 tab 为活动。目标不存在 = 全关收 pane）。 */
    closeViewerOthers(id) {
      const cur = get().viewer;
      const keep = cur.tabs.find((x) => x.id === id);
      if (!keep) {
        set({
          viewer: { open: false, tabs: [], activeId: null, treeRoot: cur.treeRoot, treeCollapsed: cur.treeCollapsed },
          viewerAutoSuppressed: true,
        });
        return;
      }
      set({ viewer: { ...cur, tabs: [keep], activeId: keep.id, open: true } });
    },

    /** 关掉指定 tab 左侧的全部（tab 栏右键菜单）。 */
    closeViewerLeft(id) {
      const cur = get().viewer;
      const idx = cur.tabs.findIndex((x) => x.id === id);
      if (idx <= 0) return; // 最左（或没这个 tab）没有左侧
      const tabs = cur.tabs.filter((x, i) => i >= idx);
      const activeId = tabs.some((x) => x.id === cur.activeId)
        ? cur.activeId
        : tabs[0].id;
      set({ viewer: { ...cur, tabs, activeId } });
    },

    /** 关掉指定 tab 右侧的全部（tab 栏右键菜单）。 */
    closeViewerRight(id) {
      const cur = get().viewer;
      const idx = cur.tabs.findIndex((x) => x.id === id);
      if (idx < 0 || idx === cur.tabs.length - 1) return; // 最右没有右侧
      const tabs = cur.tabs.filter((x, i) => i <= idx);
      const activeId = tabs.some((x) => x.id === cur.activeId)
        ? cur.activeId
        : tabs[tabs.length - 1].id;
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
