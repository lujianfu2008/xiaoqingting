import type { ScheduleView } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";
import { ScheduleForm } from "../settings/ScheduleForm";

// 定时任务编辑弹窗：✎ 按钮置位 editingSchedule 后渲染。
// Overlay 包 ScheduleForm，initial 传当前值，提交走 updateSchedule。
export function EditScheduleDialog({
  schedule,
  onClose,
}: {
  schedule: ScheduleView;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 380 }}>
        <h2>{t("sc.editSchedule")}</h2>
        <ScheduleForm initial={schedule} onDone={onClose} />
      </div>
    </Overlay>
  );
}
