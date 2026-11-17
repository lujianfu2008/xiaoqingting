package com.xiaoqingting.mobile.capability

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.xiaoqingting.mobile.MainActivity
import com.xiaoqingting.mobile.bridge.BlmBlobs
import com.xiaoqingting.mobile.bridge.Capability
import com.xiaoqingting.mobile.bridge.Rpc
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong

/**
 * M1 核心能力：blob 通道 / 通知 / 聚焦 / 附件存取（私有目录）/
 * 本机执行拒绝回执。语言与登录锁在 renderer 侧 localStorage 或
 * no-op，不经桥。
 *
 * 回执约定：renderer 的 transport.call() 把参数打包成
 * { "__callId": "...", ...业务参数 }；能力模块处理后必须
 * rpc.complete/fail(该 callId, 结果 JSON)。
 */
class CoreCapability(private val context: Context) : Capability {

    private val notifSeq = AtomicLong(0)

    override fun handle(method: String, args: JSONObject, rpc: Rpc): Boolean {
        val callId = args.optString("__callId", "")
        when (method) {
            "blob.append" -> {
                handleBlobAppend(args, callId, rpc)
                return true
            }
            "app.focus" -> {
                MainActivity.bringToFront(context)
                rpc.complete(callId, "null")
                return true
            }
            "notify.show" -> {
                showNotification(args, callId, rpc)
                return true
            }
            "attachments.save" -> {
                saveAttachment(args, callId, rpc)
                return true
            }
            "attachments.preview" -> {
                previewAttachment(args, callId, rpc)
                return true
            }
            "attachments.mark" -> {
                // 标记表 M3 接 read_attachment 时用；M1 仅受理成功。
                rpc.complete(callId, "null")
                return true
            }
            "exec.local" -> {
                rpc.fail(
                    callId,
                    JSONObject().put("error", "移动端暂不支持本机执行，请在桌面端在线时使用。").toString(),
                )
                return true
            }
            else -> return false
        }
    }

    private fun handleBlobAppend(args: JSONObject, callId: String, rpc: Rpc) {
        val data = args.optString("data", "")
        val bytes = try {
            Base64.getDecoder().decode(data)
        } catch (e: IllegalArgumentException) {
            rpc.fail(callId, JSONObject().put("error", "bad base64").toString())
            return
        }
        val id = args.optString("id", "")
        val final = args.optBoolean("final", true)
        if (id.isEmpty()) {
            rpc.complete(callId, JSONObject().put("id", BlmBlobs.create(bytes)).toString())
        } else {
            BlmBlobs.append(id, bytes, final)
            rpc.complete(callId, JSONObject().put("id", id).toString())
        }
    }

    private fun showNotification(args: JSONObject, callId: String, rpc: Rpc) {
        val title = args.optString("title", "小蜻蜓")
        val body = args.optString("body", "")
        val sessionId = if (args.isNull("session_id")) null else args.optString("session_id", null)

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "消息通知", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            // 未授权：静默降级（应用内提醒仍在）。
            rpc.complete(callId, "null")
            return
        }

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra("notify_session_id", sessionId)
        }
        val pi = PendingIntent.getActivity(
            context,
            notifSeq.incrementAndGet().toInt(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            nm.notify(notifSeq.incrementAndGet().toInt(), n)
        } catch (e: Exception) {
            // 通知失败不影响主链路。
        }
        rpc.complete(callId, "null")
    }

    private fun attachmentsDir(): java.io.File {
        val d = java.io.File(context.filesDir, "attachments")
        if (!d.exists()) d.mkdirs()
        return d
    }

    /** 附件存私有目录；path 返回形如 "att://<name>" 的引用
     * （read_attachment/previewAttachment 经桥按名字取回）。 */
    private fun saveAttachment(args: JSONObject, callId: String, rpc: Rpc) {
        val name = args.optString("name", "file")
        val blobId = args.optString("blob", "")
        val bytes = BlmBlobs.get(blobId)
        if (bytes == null) {
            rpc.fail(callId, JSONObject().put("error", "blob not found").toString())
            return
        }
        // 文件名消毒：只保留安全字符，防目录穿越。
        val safe = name.replace(Regex("[^\\w.\\-\\u4e00-\\u9fa5]"), "_")
        val f = java.io.File(attachmentsDir(), safe)
        try {
            f.writeBytes(bytes)
            val r = JSONObject()
            r.put("path", "att://${f.name}")
            rpc.complete(callId, r.toString())
        } catch (e: Exception) {
            rpc.fail(callId, JSONObject().put("error", "${e.message}").toString())
        } finally {
            BlmBlobs.remove(blobId)
        }
    }

    /** 预览（图片缩略）：按 att:// 名读回，dataUrl 直接返回
     * （缩略图 ≤256KB 走 JSON base64，符合桥协议约定）。 */
    private fun previewAttachment(args: JSONObject, callId: String, rpc: Rpc) {
        val path = args.optString("path", "")
        if (!path.startsWith("att://")) {
            rpc.fail(callId, JSONObject().put("error", "unknown path").toString())
            return
        }
        val safe = path.removePrefix("att://").replace(Regex("[^\\w.\\-\\u4e00-\\u9fa5]"), "_")
        val f = java.io.File(attachmentsDir(), safe)
        if (!f.exists()) {
            rpc.fail(callId, JSONObject().put("error", "not found").toString())
            return
        }
        // >256KB 不做缩略（chip 显示纯图标即可，与桌面一致）。
        if (f.length() > 256 * 1024) {
            rpc.complete(callId, JSONObject().toString())
            return
        }
        val mime = when (f.extension.lowercase()) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            else -> {
                // 非图片：chip 显示纯图标（与桌面一致）。
                rpc.complete(callId, JSONObject().toString())
                return
            }
        }
        val b64 = Base64.getEncoder().encodeToString(f.readBytes())
        val r = JSONObject().put("dataUrl", "data:$mime;base64,$b64")
        rpc.complete(callId, r.toString())
    }

    companion object {
        private const val CHANNEL_ID = "messages"
    }
}
