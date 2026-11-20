import { useState } from "react";
import { useT } from "../../../i18n";
import type { ViewerProps } from "../../viewer/registry";
import { toViewerUrl } from "../toViewerUrl";

// 图片与音视频：src 走 viewer:// 协议流（main 侧对音视频
// 自实现 Range 206，拖进度条不会整段重下）。加载失败给
// 「用系统打开」逃生口。图片支持内容缩放（Ctrl+滚轮 /
// Ctrl+=·-·0，倍率从 useViewerZoom 传入；放大溢出可平移，
// 见 .viewer-media.zoomable 的 CSS）。

export default function MediaViewer({ path, name, zoom }: ViewerProps): React.JSX.Element {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const isVideo = ["mp4", "webm", "mkv", "mov"].includes(ext);
  const isAudio = ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext);
  const isImage = !isVideo && !isAudio;
  const url = toViewerUrl(path);
  const z = isImage && zoom && zoom !== 1 ? zoom : undefined;

  const sysOpen = (): void => {
    void window.blm.viewer.openExternal(path);
  };

  if (failed) {
    return (
      <div className="viewer-status">
        {t("vw.loadFail")}
        <button onClick={sysOpen}>{t("vw.openExternal")}</button>
      </div>
    );
  }

  return (
    <div className={isImage && z ? "viewer-media zoomable" : "viewer-media"}>
      {isVideo ? (
        <video key={path} src={url} controls preload="metadata" onError={() => setFailed(true)} />
      ) : isAudio ? (
        <audio key={path} src={url} controls onError={() => setFailed(true)} />
      ) : (
        <img
          key={path}
          src={url}
          alt={name}
          style={z ? { width: `${z * 100}%`, maxWidth: "none" } : undefined}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
