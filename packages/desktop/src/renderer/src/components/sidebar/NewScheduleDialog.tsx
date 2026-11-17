import type { ProjectMeta } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";
import { ScheduleForm } from "../settings/ScheduleForm";

// 定时任务项目组内「＋新建定时任务」：Overlay 包共享 ScheduleForm，
// projectPreset 预设归属项目与项目所选 agent。
export function NewScheduleDialog({
  project,
  onClose,
}: {
  project: ProjectMeta;
  onClose: () => void;
}): React.JSX.Element {
  const loadSchedules = useStore((s) => s.loadSchedules);
  const t = useT();

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h2>
          ⏰ {project.name} · {t("proj.newSchedule")}
        </h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "4px 0 8px" }}>
          {t("np.kindScheduledHint")}
        </p>
        <div className="dialog-scroll">
        <ScheduleForm
          initial={null}
          projectPreset={{ project_id: project.project_id, agentId: project.agent_id }}
          onDone={() => {
            void loadSchedules();
            onClose();
          }}
        />
        </div>
      </div>
    </Overlay>
  );
}
