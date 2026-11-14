import type { BlmState, GetState, SetState } from "../types";
import { TRUSTABLE_ACTIONS, executorOfTask } from "../types";
import { sendExecResult, sendJson, socketOpen, armSendAck, pendingAcksForSession } from "../socket";
import { useStore } from "../index";
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
    .then((result) => {
      sendExecResult(req.request_id, result);
      // agent 读取/写入文件成功时自动弹出阅读器（设置可关；
      // 只跟当前会话——后台会话读文件不打扰）。
      maybeAutoOpenViewer(req, result);
    })
    .catch((e: unknown) =>
      sendExecResult(req.request_id, {
        ok: false,
        error: e instanceof Error ? e.message : t("err.execFail"),
      }),
    );
}

/** 「agent 读文件时自动打开阅读器」的钩子（读/写/列目录成功后调用）。 */
const AUTO_OPEN_ACTIONS = new Set(["read_file", "read_attachment", "write_file"]);
const AUTO_OPEN_PARAMS: Record<string, string> = {
  read_file: "path",
  read_attachment: "path",
  write_file: "path",
};

function maybeAutoOpenViewer(
  req: { action: string; params: Record<string, unknown>; session_id?: string },
  result: { ok?: boolean },
): void {
  const s = useStore.getState();
  if (!s.viewerAutoOpen || !result.ok) return;
  // 只对当前正查看的会话生效：后台会话的工具调用不打扰。
  if (!s.currentSessionId || (req.session_id && req.session_id !== s.currentSessionId)) return;
  const key = AUTO_OPEN_PARAMS[req.action];
  const p = key ? req.params[key] : undefined;
  if (typeof p !== "string" || !p) return;
  s.openViewerFiles([p]);
}

export function createChatActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "send"
  | "regenerate"
  | "interrupt"
  | "respondPermission"
  | "respondExec"
  | "setDraft"
  | "appendDraft"
  | "addAttachments"
  | "removeAttachment"
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
      const sid = currentSessionId;
      // 附件在各自 tab 中独立维护。
      const attachments = get().attachments[sid] ?? [];
      // Attachment lines ride in the message body: [附件] <name> → <abs path>.
      // Mark them in the main process first: files kept at their original
      // location (drag/pick) must stay readable even outside the access scope.
      void window.blm.markAttachments(sid, attachments.map((a) => a.path));
      const lines = attachments.map((a) => `[附件] ${a.name} → ${a.path}`);
      const outgoing = [text, ...lines].filter(Boolean).join("\n\n");
      // 每条消息自带送达确认 id：回合进行中连发补充消息时，多个 ack 各自独立
      // 结算，服务端回显该 id 的 user_text 块即确认。
      const clientMsgId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      sendJson({
        type: "user_message",
        session_id: sid,
        text: outgoing,
        client_msg_id: clientMsgId,
      });
      // No local echo here — the server broadcasts the user_text block to every
      // connection of shared sessions (owner included), avoiding duplicates.
      set((s) => ({
        busy: { ...s.busy, [sid]: true },
        attachments: { ...s.attachments, [sid]: [] },
      }));
      // 服务端回显 user_text 块即送达确认；超时/断线则提示并把文本放回
      // 该会话的草稿（附件同理放回该会话）。超时只复位「没有其它在途
      // 发送」的 busy：补充消息连发时，别的消息确认到了就说明链路
      // 正常、回复会接上。
      armSendAck(clientMsgId, sid, outgoing, () => {
        set((s) => ({
          error: t("err.sendTimeout"),
          busy:
            pendingAcksForSession(sid) > 0
              ? s.busy
              : { ...s.busy, [sid]: false },
          draftsBySession: {
            ...s.draftsBySession,
            [sid]: s.draftsBySession[sid]
              ? `${text}\n${s.draftsBySession[sid]}`
              : text,
          },
          // 失败时附件放回该会话（成功发送时已清）。
          attachments: {
            ...s.attachments,
            [sid]: [...(s.attachments[sid] ?? []), ...attachments],
          },
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

    regenerate() {
      const { currentSessionId, wsStatus } = get();
      if (!socketOpen() || wsStatus !== "connected" || !currentSessionId) {
        set({ error: t("err.offline") });
        return;
      }
      stopAudio();
      set({ speaking: false });
      // 服务端从落库历史取最后一条用户消息原文重发（不追加新块）。
      // busy 由 result/error 复位；断线重连路径里也会复位。
      sendJson({ type: "regenerate", session_id: currentSessionId });
      set((s) => ({ busy: { ...s.busy, [currentSessionId]: true } }));
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
      const sid = get().currentSessionId;
      if (!sid) return; // 无会话时输入框禁用，草稿无处安放
      set((s) => ({ draftsBySession: { ...s.draftsBySession, [sid]: text } }));
    },

    appendDraft(text) {
      const sid = get().currentSessionId;
      if (!sid) return;
      set((s) => {
        const cur = s.draftsBySession[sid] ?? "";
        return { draftsBySession: { ...s.draftsBySession, [sid]: cur ? `${cur} ${text}` : text } };
      });
    },

    addAttachments(items) {
      const sid = get().currentSessionId;
      if (!sid || items.length === 0) return;
      set((s) => {
        const cur = s.attachments[sid] ?? [];
        const add = items.filter((x) => !cur.some((y) => y.path === x.path));
        return { attachments: { ...s.attachments, [sid]: [...cur, ...add] } };
      });
    },

    removeAttachment(index) {
      const sid = get().currentSessionId;
      if (!sid) return;
      set((s) => ({
        attachments: {
          ...s.attachments,
          [sid]: (s.attachments[sid] ?? []).filter((_, i) => i !== index),
        },
      }));
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
