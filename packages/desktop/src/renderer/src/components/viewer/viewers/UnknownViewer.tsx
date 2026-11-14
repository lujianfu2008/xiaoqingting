import { useT } from "../../../i18n";
import type { ViewerProps } from "../registry";
import { kindOf } from "../registry";

// 兜底 viewer：pdf / 办公文档 / 未知二进制等暂不支持预览的
// 格式——说明清楚，交给系统默认程序打开。

export default function UnknownViewer({ path, name }: ViewerProps): React.JSX.Element {
  const t = useT();
  const kind = kindOf(name);
  const hint =
    kind === "unknown"
      ? t("vw.unsupported")
      : t("vw.unsupportedKind", { kind });
  return (
    <div className="viewer-status">
      <div>{name}</div>
      <div>{hint}</div>
      <button onClick={() => void window.blm.viewer.openExternal(path)}>
        {t("vw.openExternal")}
      </button>
    </div>
  );
}

