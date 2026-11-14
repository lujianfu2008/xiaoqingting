import type { BlmState, GetState, SetState } from "../types";

let browserInit = false;

export function createBrowserActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "initBrowser"
  | "setBrowserActiveSession"
  | "setBrowserMode"
  | "closeBrowser"
> {
  return {
    initBrowser() {
      // Pull the persisted mode from the main process and follow its state pushes
      // (navigation, title, open/close, mode switches). Register once per app
      // session so logging out and back in does not stack listeners.
      if (browserInit) return;
      browserInit = true;
      void window.blm.browser.state().then((s) => set({ browser: s }));
      window.blm.browser.onState((s) => set({ browser: s }));
    },

    // Tab focus moved: tell main which session's page to show
    // (null = nothing focused — main drops every page).
    setBrowserActiveSession(sessionId) {
      const cur = get().browser;
      // Optimistic: the pane must collapse immediately on switching to
      // a tab without a page, not after the IPC round-trip.
      if (!sessionId || (cur.open && cur.session_id !== sessionId)) {
        set({
          browser: { ...cur, open: false, url: "", title: "", session_id: sessionId ?? "" },
        });
      } else if (!cur.open) {
        set({ browser: { ...cur, open: false, session_id: sessionId } });
      }
      void window.blm.browser.setActiveSession(sessionId).catch(() => undefined);
    },

    async setBrowserMode(mode) {
      const s = await window.blm.browser.setMode(mode);
      set({ browser: s });
    },

    async closeBrowser() {
      await window.blm.browser.close();
      // ✕ 关的是当前 tab 的页面：立即收起面板（主进程 emit
      // 会再推一次准确状态，这里先把 open 打掉避免闪烁）。
      const cur = get().browser;
      if (cur.session_id) set({ browser: { ...cur, open: false } });
    },
  };
}
