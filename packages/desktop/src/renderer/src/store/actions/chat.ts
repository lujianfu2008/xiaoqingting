import type { BlmState, GetState, SetState } from "../types";
import { TRUSTABLE_ACTIONS, executorOfTask } from "../types";
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
      // 协作线程跟随当前负责人（工作台跟随指派），普通共享会话仍是 owner：
      // 负责人不在线时快速失败，而不是让引擎卡在本机执行超时上（服务端同样执法）。
      const flowTask = get().tasks.find((tk) => tk.session_id === currentSessionId);
      const executor = flowTask ? executorOfTask(flowTask) : null;
      const targetOnline = executor
        ? (get().presence[executor] ?? false)
        : get().ownerOnlineOf(currentSessionId);
      if (sharedView && !targetOnline) {
        set({ error: t(executor ? "err.executorOffline" : "err.ownerOffline") });
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

    respondPermission(requestId, allow) {
      const { pendingPermission } = get();
      const req = pendingPermission.find((r) => r.request_id === requestId);
      if (!req) return;
      if (!socketOpen()) {
        // 断线时不关弹窗：提示后等重连，用户可再答。
        set({ error: t("err.offline") });
        return;
      }
      // 先出队再发送：失败时服务端有超时兜底，本地不留僵尸弹窗。
      set((s) => ({
        pendingPermission: s.pendingPermission.filter((r) => r.request_id !== requestId),
      }));
      sendJson({ type: "permission_response", request_id: requestId, allow });
    },

    respondExec(requestId, allow, trustFromNow) {
      const { pendingExec } = get();
      const req = pendingExec.find((r) => r.request_id === requestId);
      if (!req) return;
      if (!socketOpen()) {
        set({ error: t("err.offline") });
        return;
      }
      set((s) => ({
        pendingExec: s.pendingExec.filter((r) => r.request_id !== requestId),
      }));
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
