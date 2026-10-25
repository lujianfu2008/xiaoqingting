import { useStore } from "../store";
import { useT } from "../i18n";

export function PermissionDialog(): React.JSX.Element | null {
  const pending = useStore((s) => s.pendingPermission);
  const respond = useStore((s) => s.respondPermission);
  const t = useT();

  if (!pending) return null;

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>{t("perm.title")}</h2>
        <div style={{ color: "var(--muted)" }}>
          {t("perm.desc", { tool: pending.tool_name })}
        </div>
        <pre>{JSON.stringify(pending.input, null, 2)}</pre>
        <div className="actions">
          <button onClick={() => respond(false)}>{t("perm.deny")}</button>
          <button className="primary" onClick={() => respond(true)}>
            {t("perm.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
