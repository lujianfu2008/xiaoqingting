// Android 壳兼容层安装点：本模块必须是 main.tsx 的第一个 import。
// 桌面端 preload 在页面脚本之前注入 window.blm —— 命中即退，
// 桌面零回归；Android WebView 里没有 preload，这里用
// BlmAndroidBridge（Kotlin addJavascriptInterface）装出同签名
// window.blm，业务调用点因此不需要任何平台守卫。
import { nativeBridge, probeBridgeInfo } from "./transport";
import { createBlmCompat } from "./compat";

if (typeof window.blm === "undefined" && nativeBridge() && probeBridgeInfo()?.kind === "android") {
  window.blm = createBlmCompat() as typeof window.blm;
}
