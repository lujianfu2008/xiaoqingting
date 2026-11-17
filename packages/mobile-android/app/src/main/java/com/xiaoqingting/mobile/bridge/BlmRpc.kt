package com.xiaoqingting.mobile.bridge

/**
 * 通用 RPC 中枢：
 *  - BlmBridge（@JavascriptInterface）invoke() 同步受理 →
 *  - 各 Capability 在主线程协程里执行 →
 *  - evaluateJavascript("window.__blmResolve(...)") 回执。
 * 事件（原生 → JS）走 window.__blmEvent。
 * renderer 的 transport.call() 把 callId 塞进 args.__callId。
 */
object BlmRpc : Rpc {
    private var webView: android.webkit.WebView? = null
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val capabilities = mutableListOf<Capability>()
    // 页面未就绪期间的回执/事件缓存（onPageReady 后 flush）。
    private val backlog = mutableListOf<String>()

    @Volatile
    var pageReady: Boolean = false

    fun attach(wv: android.webkit.WebView) {
        webView = wv
    }

    fun register(cap: Capability) {
        capabilities.add(cap)
    }

    /** 页面就绪（onPageFinished）：补放早到的回执/事件。 */
    fun onPageReady() {
        pageReady = true
        synchronized(backlog) {
            val pending = backlog.toList()
            backlog.clear()
            for (js in pending) eval(js)
        }
    }

    // ---------- Rpc ----------

    override fun complete(callId: String, resultJson: String) {
        resolve(callId, true, resultJson)
    }

    override fun fail(callId: String, errorJson: String) {
        resolve(callId, false, errorJson)
    }

    override fun event(name: String, payloadJson: String) {
        val payload = if (payloadJson.isEmpty()) "null" else payloadJson
        eval("window.__blmEvent && window.__blmEvent('${esc(name)}', '${esc(payload)}')")
    }

    // ---------- BlmBridge 调用链 ----------

    /**
     * invoke 入口（WebView 桥线程）：分派给能力模块。
     * 返回 "true"/"false" 字符串（@JavascriptInterface 只能
     * 同步返回基础类型）。
     */
    fun dispatch(callId: String, method: String, argsJson: String): String {
        // evaluateJavascript 必须在主线程：统一 post。
        mainHandler.post {
            val args = try {
                org.json.JSONObject(argsJson.ifEmpty { "{}" })
            } catch (e: Exception) {
                fail(callId, "{\"error\":\"bad json: ${esc(e.message ?: "")}\"}")
                return@post
            }
            for (cap in capabilities) {
                if (cap.handle(method, args, this)) return@post
            }
            fail(callId, "{\"error\":\"method not implemented: ${esc(method)}\"}")
        }
        return "true"
    }

    private fun resolve(callId: String, ok: Boolean, resultJson: String) {
        val js =
            "window.__blmResolve && window.__blmResolve('${esc(callId)}', ${if (ok) "true" else "false"}, '${esc(resultJson)}')"
        eval(js)
    }

    private fun eval(js: String) {
        val wv = webView
        if (wv == null || !pageReady) {
            synchronized(backlog) { backlog.add(js) }
            return
        }
        wv.post { wv.evaluateJavascript(js, null) }
    }

    private fun esc(s: String): String =
        s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "\\r")
}

/** 能力模块接口：method 路由，能处理返回 true（已受理）。 */
interface Capability {
    fun handle(method: String, args: org.json.JSONObject, rpc: Rpc): Boolean
}

/** RPC 上下文：能力模块用 complete/fail 回执、event 推事件。 */
interface Rpc {
    fun complete(callId: String, resultJson: String)
    fun fail(callId: String, errorJson: String)
    fun event(name: String, payloadJson: String)
}
