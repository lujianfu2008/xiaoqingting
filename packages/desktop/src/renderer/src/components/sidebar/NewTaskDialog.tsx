import { useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";

// 新建协作任务（需求 → 研发 → 测试的起点）：标题 + 需求描述。成功后切进
// 绑定会话并把描述预填输入框——需求方点发送即启动 agent 分析。
export function NewTaskDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const createTask = useStore((s) => s.createTask);
  const selectSession = useStore((s) => s.selectSession);
  const setDraft = useStore((s) => s.setDraft);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const task = await createTask({
      title: trimmed,
      ...(desc.trim() ? { description: desc.trim() } : {}),
    });
    setBusy(false);
    if (!task) {
      useStore.setState({ error: t("task.createFail") });
      return;
    }
    onClose();
    // 切进任务线程；描述预填输入框（用户确认/补改后点发送即开始分析）。
    void selectSession(task.session_id);
    if (desc.trim()) setDraft(desc.trim());
  };

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h2>{t("task.newTitle")}</h2>
        <div className="field">
          <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.titleLabel")}</label>
          <input
            autoFocus
            value={title}
            maxLength={100}
            placeholder={t("task.titlePh")}
            style={{ width: "100%", marginTop: 4 }}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.descLabel")}</label>
          <textarea
            value={desc}
            maxLength={8000}
            placeholder={t("task.descPh")}
            style={{ width: "100%", minHeight: 120, marginTop: 4 }}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        <div className="actions">
          <button onClick={onClose}>{t("np.cancel")}</button>
          <button className="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {t("task.create")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
