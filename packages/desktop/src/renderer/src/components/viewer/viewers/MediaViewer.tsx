import { useState } from "react";
import { useT } from "../../../i18n";
import type { ViewerProps } from "../../viewer/registry";
import { toViewerUrl } from "../toViewerUrl";

// 图片与音视频：src 走 viewer:// 协议流（main 侧对音视频
// 自实现 Range 206，拖进度条不会整段重下）。加载失败给
// 「用系统打开」逃生口。

export default function MediaViewer({ path, name }: ViewerProps): React.JSX.Element {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const isVideo = ["mp4", "webm", "mkv", "mov"].includes(ext);
  const isAudio = ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext);
  const url = toViewerUrl(path);

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
    <div className="viewer-media">
      {isVideo ? (
        <video key={path} src={url} controls preload="metadata" onError={() => setFailed(true)} />
      ) : isAudio ? (
        <audio key={path} src={url} controls onError={() => setFailed(true)} />
      ) : (
        <img key={path} src={url} alt={name} onError={() => setFailed(true)} />
      )}
    </div>
  );
}
