import { useState } from "react";
import { useStore } from "../store";
import { useT, type Key } from "../i18n";
import type { WsToolExecRequest } from "@blm/protocol";

const ACTION_KEYS: Record<WsToolExecRequest["action"], Key> = {
  run_command: "exec.run_command",
  read_file: "exec.read_file",
  write_file: "exec.write_file",
  list_dir: "exec.list_dir",
  get_workdir: "exec.get_workdir",
  choose_workdir: "exec.choose_workdir",
  browser_open: "exec.browser_open",
  browser_navigate: "exec.browser_navigate",
  browser_snapshot: "exec.browser_snapshot",
  browser_close: "exec.browser_close",
};

function describeParams(req: WsToolExecRequest): string {
  switch (req.action) {
    case "run_command":
      return String(req.params.command ?? "");
    case "read_file":
    case "write_file":
    case "list_dir":
      return String(req.params.path ?? "");
    case "browser_open":
    case "browser_navigate":
      return String(req.params.url ?? "");
    default:
      return "";
  }
}

export function ExecConfirmDialog(): React.JSX.Element | null {
  const pending = useStore((s) => s.pendingExec);
  const trustMode = useStore((s) => s.trustMode);
  const respond = useStore((s) => s.respondExec);
  const [trustChecked, setTrustChecked] = useState(false);
  const t = useT();

  if (!pending) return null;

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>{t("exec.title")}</h2>
        <div style={{ color: "var(--muted)" }}>
          {t("exec.desc", { action: t(ACTION_KEYS[pending.action]) })}
        </div>
        <pre>{describeParams(pending)}</pre>
        {pending.action === "write_file" && typeof pending.params.content === "string" && (
          <pre style={{ maxHeight: 160, overflow: "auto" }}>{pending.params.content.slice(0, 2000)}</pre>
        )}
        {!trustMode && (
          <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)" }}>
            <input
              type="checkbox"
              checked={trustChecked}
              onChange={(e) => setTrustChecked(e.target.checked)}
            />
            {t("exec.trustCheck")}
          </label>
        )}
        {trustMode && (
          <div style={{ color: "var(--muted)", fontSize: 12 }}>{t("exec.trustOn")}</div>
        )}
        <div className="actions">
          <button onClick={() => respond(false, false)}>{t("perm.deny")}</button>
          <button
            className="primary"
            onClick={() => {
              respond(true, trustChecked);
              setTrustChecked(false);
            }}
          >
            {t("perm.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
