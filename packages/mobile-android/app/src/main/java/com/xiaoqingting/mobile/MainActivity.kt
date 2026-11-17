package com.xiaoqingting.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.xiaoqingting.mobile.bridge.BlmBridge
import com.xiaoqingting.mobile.bridge.BlmRpc
import com.xiaoqingting.mobile.capability.CoreCapability
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * 单 Activity WebView 壳：
 *  - https://appassets.androidplatform.net/assets/renderer/index.html
 *    （WebViewAssetLoader，https 语义 origin —— localStorage 可用）
 *  - 桥只注入这个主壳 WebView（内置浏览器的子 WebView M5 另建、绝不注入）
 *  - /__blob/<id> 拦截：renderer 取原生侧大 payload
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    // 通知点击跳会话：renderer 侧 onNotifyActivate 订阅后
    // 收到 pendingSessionId。
    private var pendingSessionId: String? = null

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingMicRequest?.granted?.invoke(granted)
            pendingMicRequest = null
        }
    private var pendingMicRequest: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/__blob/") { path ->
                // path 形如 "b123"
                val bytes = com.xiaoqingting.mobile.bridge.BlmBlobs.get(path)
                if (bytes == null) {
                    WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0))).also {
                        it.statusCode = 404
                    }
                } else {
                    WebResourceResponse(
                        "application/octet-stream",
                        null,
                        java.io.ByteArrayInputStream(bytes),
                    ).also { it.statusCode = 200 }
                }
            }
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage（JWT/服务器地址/语言）
            mediaPlaybackRequiresUserGesture = false // 语音链路
            allowFileAccess = false           // 只走 AssetLoader 的 https origin
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.addJavascriptInterface(BlmBridge(), "BlmAndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                // 应用内导航限制在自家 origin；外链交给系统浏览器。
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: Exception) {
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                BlmRpc.pageReady = true
                BlmRpc.onPageReady()
                pendingSessionId?.let { sid ->
                    // renderer 期待裸字符串 payload（JSONObject.quote）。
                    BlmRpc.event("notifyActivate", org.json.JSONObject.quote(sid))
                    pendingSessionId = null
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // 只授麦克风，且只对自家 origin。
                if (request.resourceTypes.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
                    request.origin?.host == "appassets.androidplatform.net"
                ) {
                    if (Build.VERSION.SDK_INT >= 23 &&
                        ContextCompat.checkSelfPermission(this@MainActivity, android.Manifest.permission.RECORD_AUDIO) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        pendingMicRequest = request
                        micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                    }
                } else {
                    request.deny()
                }
            }
        }

        // 通知点击的会话 id（冷启动 / 热启动都经 onCreate/onNewIntent）。
        pendingSessionId = intent?.getStringExtra("notify_session_id")

        BlmRpc.attach(webView)
        BlmRpc.register(CoreCapability(this))

        webView.loadUrl("https://appassets.androidplatform.net/assets/renderer/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val sid = intent.getStringExtra("notify_session_id") ?: return
        if (BlmRpc.pageReady) {
            BlmRpc.event("notifyActivate", org.json.JSONObject.quote(sid))
        } else {
            pendingSessionId = sid
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        /** 从通知点击把任务拉回前台（CoreCapability app.focus）。 */
        fun bringToFront(context: Context) {
            val i = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(i)
        }
    }
}
