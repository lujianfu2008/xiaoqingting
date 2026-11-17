package com.xiaoqingting.mobile.bridge

/** blob 注册表（原生侧存字节，renderer 经 /__blob/<id> 取）。 */
object BlmBlobs {
    private val blobs = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
    private val seq = java.util.concurrent.atomic.AtomicLong(0)

    fun create(firstChunk: ByteArray): String {
        val id = "b${seq.incrementAndGet()}"
        blobs[id] = firstChunk
        return id
    }

    fun append(id: String, chunk: ByteArray, final: Boolean) {
        if (chunk.isNotEmpty()) {
            blobs.computeIfPresent(id) { _, cur -> cur + chunk }
        }
        if (final) trim()
    }

    fun remove(id: String) {
        blobs.remove(id)
    }

    fun get(id: String): ByteArray? = blobs[id]

    /** 简单上限保护：并发 blob 超过 32 个时丢弃最早的。 */
    private fun trim() {
        if (blobs.size > 32) {
            blobs.keys.firstOrNull()?.let { blobs.remove(it) }
        }
    }
}
