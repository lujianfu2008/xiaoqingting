import { useEffect, useState } from "react";
import { useStore, loadAgents } from "./store";
import { setLang, useT } from "./i18n";
import { LS } from "./store/persist";
import { LoginDialog } from "./components/LoginDialog";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { BrowserPane } from "./components/BrowserPane";
import { Splitter } from "./components/Splitter";
import { PaneRail, type PaneChrome, type PaneId, type PaneState } from "./components/pane/PaneTools";
import { PermissionDialog } from "./components/PermissionDialog";
import { ExecConfirmDialog } from "./components/ExecConfirmDialog";

// Pane widths, dragged with the vertical splitters between sidebar / page / chat.
const SPLITTER_W = 6;
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 460;
const BROWSER_MIN = 280;
const CHAT_MIN = 340;

interface Split {
  sidebar: number;
  browser: number;
}

// normal = shares the row; max = takes the area right of the sidebar (the view
// keeps the session list); full = takes the whole window; min = folded into a rail.
type PaneMode = "normal" | "max" | "full" | "min";
type PaneModes = Record<PaneId, PaneMode>;

const NORMAL_PANES: PaneModes = { sidebar: "normal", browser: "normal", chat: "normal" };

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

const defaultSplit = (): Split => ({
  sidebar: SIDEBAR_DEFAULT,
  browser: Math.max(BROWSER_MIN, Math.round((window.innerWidth - SIDEBAR_DEFAULT) * 0.55)),
});

/** Keep all three panes usable: sidebar 200–460, page ≥280, chat ≥340. */
function fitSplit(s: Split, vw: number, browserOpen: boolean): Split {
  const splitters = browserOpen ? SPLITTER_W * 2 : SPLITTER_W;
  const sidebarMax = Math.min(SIDEBAR_MAX, vw - CHAT_MIN - splitters - (browserOpen ? BROWSER_MIN : 0));
  const sidebar = clamp(Math.round(s.sidebar), SIDEBAR_MIN, sidebarMax);
  const browser = clamp(
    Math.round(s.browser),
    BROWSER_MIN,
    vw - sidebar - splitters - CHAT_MIN,
  );
  return { sidebar, browser };
}

function loadSplit(): Split {
  const d = defaultSplit();
  const read = (key: string, fallback: number): number => {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { sidebar: read(LS.sidebarWidth, d.sidebar), browser: read(LS.browserWidth, d.browser) };
}

export default function App(): React.JSX.Element {
  const token = useStore((s) => s.token);
  const connect = useStore((s) => s.connect);
  const initBrowser = useStore((s) => s.initBrowser);
  const gateLocalLogin = useStore((s) => s.gateLocalLogin);
  const embedded = useStore((s) => s.browser.open && s.browser.mode === "embedded");
  const t = useT();

  // What the user asked for, and what actually fits. Keeping them apart means a
  // temporarily narrow window only squeezes the panes on screen — it never
  // overwrites the saved widths with the squeezed ones.
  const [wanted, setWanted] = useState<Split>(loadSplit);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  // While a splitter is dragged the native browser view is hidden: it paints
  // above the renderer, so pointer moves that cross it would never reach us.
  const [dragging, setDragging] = useState(false);
  const [panes, setPanes] = useState<PaneModes>(NORMAL_PANES);

  // At most one pane is expanded; expanding it also unfolds the others, since
  // it takes their space. Folding, by contrast, leaves the others alone and they
  // grow into the gap.
  const expanded = (Object.keys(panes) as PaneId[]).find(
    (id) => panes[id] === "max" || panes[id] === "full",
  ) ?? null;
  const solo = expanded !== null && (expanded === "sidebar" || panes[expanded] === "full");
  const visible = (id: PaneId): boolean => {
    if (panes[id] === "min") return false;
    if (!expanded) return true;
    if (id === expanded) return true;
    // Only a pane expanded to the main area leaves the session list in place.
    return id === "sidebar" && panes[expanded] === "max";
  };
  const browserShown = embedded && visible("browser");
  const chatShown = visible("chat");
  // With the chat folded away the page grows into its space; with the page
  // expanded the chat is hidden and the page must not keep its old width.
  const fillsRight = expanded ? expanded === "browser" && panes.browser === "max" : !chatShown;
  const split = fitSplit(wanted, viewport, browserShown);

  // The page can leave the pane (✕ close, or 弹窗) while its pane is maximised
  // or folded; the pane mode would otherwise hide the way back (the popup tip
  // lives inside BrowserPane).
  useEffect(() => {
    if (!embedded && panes.browser !== "normal") {
      setPanes((p) => ({ ...p, browser: "normal" }));
    }
  }, [embedded, panes.browser]);

  useEffect(() => {
    const onResize = (): void => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    localStorage.setItem(LS.sidebarWidth, String(wanted.sidebar));
    localStorage.setItem(LS.browserWidth, String(wanted.browser));
  }, [wanted]);

  // Sync the renderer i18n with the menu language chosen in the main process
  // (document lang + every translated string re-render via the i18n store).
  useEffect(() => {
    const apply = (lang: string): void => setLang(lang === "en" ? "en" : "zh-CN");
    void window.blm.getLanguage().then(apply);
    return window.blm.onLangChanged(apply);
  }, []);

  // Connect once per login; reconnection with backoff is handled inside the
  // store. Gated by the local single-login lock: if this account is already
  // signed in in another instance on this machine, show the login screen
  // (gateLocalLogin drops the in-memory token) instead of connecting.
  useEffect(() => {
    if (!token || useStore.getState().wsStatus !== "disconnected") return;
    let alive = true;
    void gateLocalLogin().then((blocked) => {
      if (!alive || blocked) return;
      void loadAgents();
      connect();
    });
    return () => {
      alive = false;
    };
  }, [token, connect, gateLocalLogin]);

  useEffect(() => {
    if (token) initBrowser();
  }, [token, initBrowser]);

  if (!token) return <LoginDialog />;

  // The sidebar sits at x=0, so the pointer's clientX *is* its new width.
  // Dragging stores the value the user landed on, clamped to what the window
  // allows right now.
  const dragSidebar = (clientX: number): void =>
    setWanted((s) => fitSplit({ ...s, sidebar: clientX }, viewport, browserShown));
  // The page pane starts right after the sidebar + its splitter.
  const dragBrowser = (clientX: number): void =>
    setWanted((s) =>
      fitSplit({ ...s, browser: clientX - split.sidebar - SPLITTER_W }, viewport, browserShown),
    );

  const setMode = (id: PaneId, mode: PaneMode): void =>
    setPanes({ ...NORMAL_PANES, [id]: mode });
  const chrome = (id: PaneId): PaneChrome => {
    const mode = panes[id];
    const state: PaneState = mode === "max" ? "max" : mode === "full" ? "full" : "normal";
    const restore: Pick<PaneChrome, "onMinimize" | "onRestore"> = {
      // Folding only hides this pane; the rest keep their layout and grow.
      onMinimize: () => setPanes((p) => ({ ...p, [id]: "min" })),
      onRestore: () => setPanes(NORMAL_PANES),
    };
    // The sidebar has no main area of its own, so filling the window *is* its
    // only expansion — one button, labelled accordingly.
    if (id === "sidebar") {
      return {
        ...restore,
        state: state === "normal" ? "normal" : "full",
        onFullscreen: () => setMode(id, "full"),
        fullscreenTitle: t("pane.fullChatTip"),
      };
    }
    return {
      ...restore,
      state,
      onMaximize: () => setMode(id, "max"),
      onFullscreen: () => setMode(id, "full"),
    };
  };

  const appClass = ["app", solo && "solo", fillsRight && "fill-right"].filter(Boolean).join(" ");

  return (
    <div
      className={appClass}
      style={
        {
          "--sidebar-w": `${split.sidebar}px`,
          "--browser-w": `${split.browser}px`,
        } as React.CSSProperties
      }
    >
      {visible("sidebar") ? (
        <Sidebar chrome={chrome("sidebar")} />
      ) : panes.sidebar === "min" && (!expanded || panes[expanded] === "max") ? (
        // Stays reachable while another pane fills the main area: the way back
        // to the session list must not disappear with it.
        <PaneRail side="left" label={t("pane.railSessions")} icon="☰" onExpand={() => setPanes(NORMAL_PANES)} />
      ) : null}

      {expanded !== "sidebar" && visible("sidebar") && <Splitter label={t("pane.splitSidebar")} onDrag={dragSidebar} onReset={() => setWanted((s) => fitSplit({ ...s, sidebar: SIDEBAR_DEFAULT }, viewport, browserShown))} onDragChange={setDragging} />}

      {visible("browser") ? (
        <BrowserPane suspended={dragging} chrome={chrome("browser")} />
      ) : embedded && panes.browser === "min" && !expanded ? (
        <PaneRail side="left" label={t("pane.railBrowser")} icon="🌐" onExpand={() => setPanes(NORMAL_PANES)} />
      ) : null}

      {browserShown && chatShown && !expanded && (
        <Splitter
          label={t("pane.splitBrowser")}
          onDrag={dragBrowser}
          onReset={() => setWanted((s) => fitSplit({ ...s, browser: defaultSplit().browser }, viewport, browserShown))}
          onDragChange={setDragging}
        />
      )}

      {visible("chat") ? (
        <ChatPane chrome={chrome("chat")} />
      ) : panes.chat === "min" && !expanded ? (
        <PaneRail side="right" label={t("pane.railChat")} icon="💬" onExpand={() => setPanes(NORMAL_PANES)} />
      ) : null}

      <PermissionDialog />
      <ExecConfirmDialog />
    </div>
  );
}
