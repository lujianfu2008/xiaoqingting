// renderer 产物同步：把 packages/desktop/out/renderer 复制进
// assets/renderer（构建前执行）。产物由 npm run build -w @blm/desktop
// 生成（electron-vite build，Linux 上即可完成）。
val rendererOut = file("../../../packages/desktop/out/renderer")
val rendererAssets = file("app/src/main/assets/renderer")

tasks.register<Copy>("copyRenderer") {
    group = "blm"
    description = "同步桌面 renderer 构建产物到 Android assets"
    from(rendererOut)
    into(rendererAssets)
    // index.html 引用相对路径 assets/...，原样保留目录结构。
}

tasks.register<Delete>("cleanRenderer") {
    delete(rendererAssets)
}
