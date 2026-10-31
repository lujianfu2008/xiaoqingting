import type { BlmState, GetState, SetState } from "../types";
import { TRUSTABLE_ACTIONS } from "../types";
import { sendExecResult, sendJson, socketOpen, armSendAck } from "../socket";
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
  | "send"
  | "interrupt"
  | "respondPermission"
  | "respondExec"
  | "setDraft"
  | "appendDraft"
  | "setTrustMode"
  | "setRecording"
> {
  return {
    send(text) {
      const { currentSessionId, wsStatus, sharedView } = get();
      if (!socketOpen() || wsStatus !== "connected" || !currentSessionId) {
        // 断线/半开连接：明确反馈而不是静默丢弃；调用方保留草稿不清空。
        set({ error: t("err.offline") });
        return false;
      }
      // Collaborators need the owner online to approve local actions — fail fast
      // here instead of letting the engine stall (the server enforces this too).
      if (sharedView && !get().ownerOnlineOf(currentSessionId)) {
        set({ error: t("err.ownerOffline") });
        return false;
      }
      stopAudio();
      set({ speaking: false });
      sendJson({ type: "user_message", session_id: currentSessionId, text });
      // No local echo here — the server broadcasts the user_text block to every
      // connection of shared sessions (owner included), avoiding duplicates.
      set((s) => ({
        busy: { ...s.busy, [currentSessionId]: true },
      }));
      // 服务端回显 user_text 块即送达确认；超时/断线则提示并把文本放回输入框。
      armSendAck(currentSessionId, () => {
        set((s) => ({
          error: t("err.sendTimeout"),
          busy: { ...s.busy, [currentSessionId]: false },
          draft: s.draft ? `${text}\n${s.draft}` : text,
        }));
      });
      return true;
    },

    interrupt() {
      const { currentSessionId, wsStatus } = get();
      if (!socketOpen() || wsStatus !== "connected" || !currentSessionId) {
        set({ error: t("err.offline") });
        return;
      }
      stopAudio();
      set({ speaking: false });
      sendJson({ type: "interrupt", session_id: currentSessionId });
    },

    respondPermission(allow) {
      const { pendingPermission } = get();
      if (!pendingPermission) return;
      if (!socketOpen()) {
        // 断线时不关弹窗：提示后等重连，用户可再答。
        set({ error: t("err.offline") });
        return;
      }
      sendJson({
        type: "permission_response",
        request_id: pendingPermission.request_id,
        allow,
      });
      set({ pendingPermission: null });
    },

    respondExec(allow, trustFromNow) {
      const { pendingExec } = get();
      if (!pendingExec) return;
      if (!socketOpen()) {
        set({ error: t("err.offline") });
        return;
      }
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

    setDraft(text) {
      set({ draft: text });
    },

    appendDraft(text) {
      set((s) => ({ draft: s.draft ? `${s.draft} ${text}` : text }));
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
