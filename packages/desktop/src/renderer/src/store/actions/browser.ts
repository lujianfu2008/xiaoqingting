import type { BlmState, GetState, SetState } from "../types";

let browserInit = false;

export function createBrowserActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "initBrowser" | "setBrowserMode" | "closeBrowser"> {
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

    async setBrowserMode(mode) {
      const s = await window.blm.browser.setMode(mode);
      set({ browser: s });
    },

    async closeBrowser() {
      await window.blm.browser.close();
    },
  };
}
