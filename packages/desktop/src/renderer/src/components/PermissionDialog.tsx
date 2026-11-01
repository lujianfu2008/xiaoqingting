import { useStore } from "../store";
import { useT } from "../i18n";

export function PermissionDialog(): React.JSX.Element | null {
  // 并发审批队列：渲染队首，应答后自动轮到下一个（标题提示剩余数）。
  const queue = useStore((s) => s.pendingPermission);
  const pending = queue[0];
  const respond = useStore((s) => s.respondPermission);
  const t = useT();

  if (!pending) return null;

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>
          {t("perm.title")}
          {queue.length > 1 ? t("perm.queued", { n: queue.length - 1 }) : ""}
        </h2>
        <div style={{ color: "var(--muted)" }}>
          {pending.agent_name
            ? t("perm.agentDesc", { agent: pending.agent_name, tool: pending.tool_name })
            : t("perm.desc", { tool: pending.tool_name })}
        </div>
        <pre>{JSON.stringify(pending.input, null, 2)}</pre>
        <div className="actions">
          <button onClick={() => respond(pending.request_id, false)}>{t("perm.deny")}</button>
          <button className="primary" onClick={() => respond(pending.request_id, true)}>
            {t("perm.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
