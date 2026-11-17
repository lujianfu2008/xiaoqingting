package com.xiaoqingting.mobile.bridge

import android.os.Build
import android.webkit.JavascriptInterface
import com.xiaoqingting.mobile.BuildConfig

/**
 * 注入 WebView 的唯一 JS 桥（window.BlmAndroidBridge）。
 * 只暴露一个通用 RPC 入口 + 环境描述；业务能力全在
 * capability/ 模块。M5 的内置浏览器子 WebView 绝不注入本桥。
 */
class BlmBridge {
    @JavascriptInterface
    fun invoke(callId: String, method: String, argsJson: String): String =
        BlmRpc.dispatch(callId, method, argsJson)

    @JavascriptInterface
    fun bridgeInfo(): String {
        val v = org.json.JSONObject()
        v.put("kind", "android")
        v.put("app_version", BuildConfig.VERSION_NAME)
        v.put("sdk", Build.VERSION.SDK_INT)
        return v.toString()
    }
}
