import { useEffect, useState } from "react";
import type { UserSummary } from "@blm/protocol";
import { useStore } from "../store";
import { useT } from "../i18n";
import { Overlay } from "./Overlay";

// 单选用户选择器（协作流指派研发/测试）：复制 ShareDialog 的用户列表模式
// （listUsers + 状态点），不重构 ShareDialog。
export function UserPickerDialog({
  title,
  optionalSkip,
  exclude = [],
  onPick,
  onClose,
}: {
  title: string;
  /** 提供时显示「跳过」按钮（如 submit_test 可不指定测试）。 */
  optionalSkip?: string;
  /** 不出现在候选里的用户名（如已被指派的人）。 */
  exclude?: string[];
  onPick: (username: string | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const listUsers = useStore((s) => s.listUsers);
  const username = useStore((s) => s.username);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const t = useT();

  useEffect(() => {
    void listUsers().then((all) =>
      setUsers(
        all.filter((u) => u.username !== username && !exclude.includes(u.username)),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUsers, username]);

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 300 }} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div
          className="field"
          style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border, #444)", borderRadius: 6, padding: 8 }}
        >
          {users.length === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{t("sh.noUsers")}</div>
          )}
          {users.map((u) => (
            <button
              key={u.username}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 2px",
                width: "100%",
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 13,
              }}
              onClick={() => {
                onPick(u.username);
                onClose();
              }}
            >
              <span
                className={`status-dot ${u.online ? "ok" : "bad"}`}
                title={u.online ? t("sh.online") : t("sess.offline")}
              />
              <span>
                {u.employee_id} · {u.username}
              </span>
            </button>
          ))}
        </div>
        <div className="actions">
          {optionalSkip && (
            <button
              onClick={() => {
                onPick(null);
                onClose();
              }}
            >
              {optionalSkip}
            </button>
          )}
          <button onClick={onClose}>{t("np.cancel")}</button>
        </div>
      </div>
    </Overlay>
  );
}
