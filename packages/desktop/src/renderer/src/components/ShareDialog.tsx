import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import type { SessionMeta, UserSummary } from "@blm/protocol";

// Share dialog: share a session with everyone or only with picked users.

export function ShareDialog({
  session,
  onClose,
}: {
  session: SessionMeta;
  onClose: () => void;
}): React.JSX.Element {
  const setSessionShare = useStore((s) => s.setSessionShare);
  const listUsers = useStore((s) => s.listUsers);
  const username = useStore((s) => s.username);

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [mode, setMode] = useState<"everyone" | "picked">(
    (session.shared_with?.length ?? 0) > 0 ? "picked" : "everyone",
  );
  const [picked, setPicked] = useState<Set<string>>(new Set(session.shared_with ?? []));
  const [busy, setBusy] = useState(false);
  const t = useT();

  useEffect(() => {
    void listUsers().then((all) =>
      setUsers(all.filter((u) => u.username !== username)),
    );
  }, [listUsers, username]);

  const toggle = (u: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    await setSessionShare(
      session.session_id,
      true,
      mode === "everyone" ? [] : [...picked],
    );
    setBusy(false);
    onClose();
  };

  const unshare = async (): Promise<void> => {
    setBusy(true);
    await setSessionShare(session.session_id, false);
    setBusy(false);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ minWidth: 340 }} onClick={(e) => e.stopPropagation()}>
        <h2>{t("sh.title")}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "4px 0 12px" }}>
          {t("sh.desc", { title: session.title })}
        </p>

        <div className="field">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="radio"
              checked={mode === "everyone"}
              onChange={() => setMode("everyone")}
            />
            {t("sh.everyone")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <input
              type="radio"
              checked={mode === "picked"}
              onChange={() => setMode("picked")}
            />
            {t("sh.picked")}
          </label>
        </div>

        {mode === "picked" && (
          <div
            className="field"
            style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border, #444)", borderRadius: 6, padding: 8 }}
          >
            {users.length === 0 && (
              <div style={{ color: "var(--muted)", fontSize: 12 }}>{t("sh.noUsers")}</div>
            )}
            {users.map((u) => (
              <label
                key={u.username}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}
              >
                <input
                  type="checkbox"
                  checked={picked.has(u.username)}
                  onChange={() => toggle(u.username)}
                />
                <span className={`status-dot ${u.online ? "ok" : "bad"}`} title={u.online ? t("sh.online") : t("sess.offline")} />
                <span>
                  {u.employee_id} · {u.username}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="actions">
          {session.shared && (
            <button onClick={unshare} disabled={busy}>
              {t("sh.unshare")}
            </button>
          )}
          <button
            className="primary"
            onClick={() => void save()}
            disabled={busy || (mode === "picked" && picked.size === 0)}
          >
            {session.shared ? t("sh.save") : t("sh.share")}
          </button>
        </div>
      </div>
    </div>
  );
}
