import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ViewerPopupWindow } from "./components/viewer/PopupWindow";
import { initUiTheme } from "./components/theme/uiTheme";
import "./index.css";

// 界面主题在首次渲染前恢复（主窗与阅读器弹窗共用此入口，
// 两个文档各自恢复一次），避免按默认配色闪一下。
initUiTheme();

// 阅读器弹窗窗口：主进程开独立 BrowserWindow 加载本页 +
// #viewer-popup?path=<encodeURIComponent(abs)>。弹窗只渲染
// 那一个文件（不进主窗的 viewer store——两个窗口的 store 各自
// 独立，tab 状态不互通），其余一切照旧走 App。
const hash = window.location.hash;
const popupMatch = hash.match(/^#viewer-popup\?path=(.+)$/);
const popupPath = popupMatch
  ? decodeURIComponent(popupMatch[1])
  : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {popupPath ? <ViewerPopupWindow path={popupPath} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
