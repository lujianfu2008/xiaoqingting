import type { BlmState, GetState, SetState } from "../types";
import { TRUSTABLE_ACTIONS } from "../types";
import { sendExecResult, sendJson, socketOpen } from "../socket";
import { stopAudio } from "../../speech";
import { t } from "../../i18n";

function runLocally(
  req: {
    request_id: string;
    action: string;
    params: Record<string, unknown>;
    session_id?: string;
  },
): void {
  // Run in the Electron main process, then report back. session_id lets the
  // main process confine project-bound sessions to their own folder.
  window.blm
    .executeLocalAction({
      action: req.action,
      params: req.params,
      session_id: req.session_id,
    })
    .then((result) => sendExecResult(req.request_id, result))
    .catch((e: unknown) =>
      sendExecResult(req.request_id, {
        ok: false,
        error: e instanceof Error ? e.message : t("err.execFail"),
      }),
    );
}

export function createChatActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  "send" | "interrupt" | "respondPermission" | "respondExec" | "setTrustMode" | "setRecording"
> {
  return {
    send(text) {
      const { currentSessionId, wsStatus, sharedView } = get();
      if (!socketOpen() || wsStatus !== "connected" || !currentSessionId) return;
      // Collaborators need the owner online to approve local actions — fail fast
      // here instead of letting the engine stall (the server enforces this too).
      if (sharedView && !get().ownerOnlineOf(currentSessionId)) {
        set({ error: t("err.ownerOffline") });
        return;
      }
      stopAudio();
      set({ speaking: false });
      sendJson({ type: "user_message", session_id: currentSessionId, text });
      // No local echo here — the server broadcasts the user_text block to every
      // connection of shared sessions (owner included), avoiding duplicates.
      set((s) => ({
        busy: { ...s.busy, [currentSessionId]: true },
      }));
    },

    interrupt() {
      const { currentSessionId, wsStatus } = get();
      if (!socketOpen() || wsStatus !== "connected" || !currentSessionId) return;
      stopAudio();
      set({ speaking: false });
      sendJson({ type: "interrupt", session_id: currentSessionId });
    },

    respondPermission(allow) {
      const { pendingPermission } = get();
      if (!socketOpen() || !pendingPermission) return;
      sendJson({
        type: "permission_response",
        request_id: pendingPermission.request_id,
        allow,
      });
      set({ pendingPermission: null });
    },

    respondExec(allow, trustFromNow) {
      const { pendingExec } = get();
      if (!socketOpen() || !pendingExec) return;
      const req = pendingExec;
      set({ pendingExec: null });
      if (trustFromNow) {
        set({ trustMode: true });
        localStorage.setItem("blm.trustMode", "1");
      }
      if (!allow) {
        sendExecResult(req.request_id, { ok: false, error: t("err.userDenied") });
        return;
      }
      runLocally({
        request_id: req.request_id,
        action: req.action,
        params: req.params as Record<string, unknown>,
        session_id: req.session_id,
      });
    },

    setTrustMode(on) {
      set({ trustMode: on });
      localStorage.setItem("blm.trustMode", on ? "1" : "0");
    },

    setRecording(on) {
      set({ recording: on });
    },
  };
}

/** Trust mode: execute the trusted action directly without prompting. */
export function autoExecIfTrusted(
  msg: {
    request_id: string;
    action: string;
    params: Record<string, unknown>;
    session_id?: string;
  },
  trustMode: boolean,
): boolean {
  if (!trustMode || !TRUSTABLE_ACTIONS.has(msg.action)) return false;
  runLocally(msg);
  return true;
}
