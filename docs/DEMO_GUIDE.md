# Demo GIF 制作指南

## 推荐工具
- **Windows**: ScreenToGif (开源免费) / ShareX
- **跨平台**: OBS + ffmpeg 转 GIF
- **在线**: 录屏后用 ezgif.com 裁剪/压缩

## 录制脚本（30 秒完整流程）
```
1. 打开桌面端 → 显示托盘图标、主窗口
2. 语音唤醒："小蜻蜓" → 头像亮起、波形动画
3. 语音输入："帮我写篇文章发掘金" → 实时识别文本
4. 展示自动打开浏览器、填标题正文、选分类标签、两层确认发布
5. 返回桌面端 → 展示文章链接、封面已生成
6. 切换到代码编辑器 → 语音："帮我加个日志" → 展示文件修改、git diff
7. 结尾：GitHub 星标 + 赞赏码淡入
```

## 技术参数
- 分辨率：1280x720 或 1920x1080
- 帧率：15-20 fps（GIF 足够）
- 时长：≤ 30 秒
- 大小：≤ 5 MB（GitHub README 直接引用）
- 关键帧：每个动作停留 1-2 秒，配合字幕/箭头标注

## ffmpeg 转换命令
```bash
# mp4 -> gif (优化体积)
ffmpeg -i demo.mp4 -vf "fps=15,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 demo.gif

# 压缩
gifsicle -O3 --lossy=80 -o demo-small.gif demo.gif
```

## 存放位置
- `docs/demo.gif` → README 顶部直接引用
- `docs/demo.mp4` → 备用高清版

---

> ⚠️ 录制前请确保：
> 1. 已配置好 .env（上游 Key、JWT_SECRET）
> 2. 离线 ASR 模型已就位
> 3. 服务端 + 桌面端均正常运行
> 4. 掘金登录态有效（.juejin-profile 目录）