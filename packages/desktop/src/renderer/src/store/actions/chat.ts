import type { BlmState, GetState, SetState } from "../types";
import { TRUSTABLE_ACTIONS, executorOfTask } from "../types";
import { sendExecResult, sendJson, socketOpen, armSendAck, pendingAcksForSession } from "../socket";
import { useStore } from "../index";
import { stopAudio } from "../../speech";
import { t } from "../../i18n";
import { base64ToBytes, downloadAttachment, isAttRef, parseAttRef, uploadAttachment } from "../../lib/attachmentRef";

// 共享会话附件上传 Promise 追踪：addAttachments 后台上传（挑选/粘贴即
// 开始），send 发送前 await 本会话所有在途上传，确保消息里带的是已就绪
// 的 att: 服务端引用而非发送方本机路径——消息先于文件到达会让宿主读到
// 一个不可达路径（跨机必失败），见 feedback：共享附件由宿主拉取，发送方
// 只负责把字节先传上服务器。key = `${sid}::${path}`。
const pendingUploads = new Map<string, Promise<void>>();

/** 等待某会话所有在途附件上传完成。 */
function waitAttachments(sid: string): Promise<void> {
  const ups = [...pendingUploads.entries()].filter(([k]) => k.startsWith(`${sid}::`));
  return Promise.all(ups.map(([, p]) => p.catch(() => undefined))).then(() => undefined);
}

function runLocally(
  req: {
    request_id: string;
    action: string;
    params: Record<string, unknown>;
    session_id?: string;
  },
): void {
  // 共享会话附件引用（att:<sid>/<id>）：字节在服务端托管，先拉取落到
  // 本机附件目录（豁免围栏），再按本地路径走既有执行链路——引擎在宿主
  // 机器上读协作方粘贴的文件由此打通；宿主自己发的文件路径本机就有，
  // 不走这条。
  if (req.action === "read_attachment" && typeof req.params.path === "string" && isAttRef(req.params.path)) {
    const ref = parseAttRef(req.params.path);
    if (!ref) {
      sendExecResult(req.request_id, { ok: false, error: "附件引用格式无效" });
      return;
    }
    void (async () => {
      try {
        const { serverUrl, token } = useStore.getState();
        const { bytes, name } = await downloadAttachment(serverUrl, token ?? "", ref);
        const sid = req.session_id ?? ref.sessionId;
        const saved = await window.blm.saveAttachment(sid, name, bytes);
        if (!saved.path) throw new Error(saved.error ?? "附件保存失败");
        runLocally({ ...req, params: { ...req.params, path: saved.path } });
      } catch (e) {
        sendExecResult(req.request_id, {
          ok: false,
          error: `附件取回失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
    return;
  }
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
      // agent 读取文件成功时自动弹出阅读器（设置可关；
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

/** 「agent 读文件时自动打开阅读器」的钩子（读成功后调用）。
 *  只挂读取动作：write_file 一轮几十次，弹出纯属打扰。 */
const AUTO_OPEN_PARAMS: Record<string, string> = {
  read_file: "path",
  read_attachment: "path",
};

function maybeAutoOpenViewer(
  req: { action: string; params: Record<string, unknown>; session_id?: string },
  result: { ok?: boolean },
): void {
  const s = useStore.getState();
  if (!s.viewerAutoOpen || !result.ok) return;
  // 用户本轮手动关掉过阅读器：不再打扰，下一条用户消息重新武装。
  if (s.viewerAutoSuppressed) return;
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
  | "recallMessage"
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
    async send(text) {
      const { currentSessionId, wsStatus, sharedView } = get();
      if (!socketOpen() || wsStatus !== "connected" || !currentSessionId) {
        // 断线/半开连接：明确反馈而不是静默丢弃；调用方保留草稿不清空。
        set({ error: t("err.offline") });
        return false;
      }
      // 新回合开始：上一轮被用户关掉过阅读器的话，恢复自动弹出资格。
      if (get().viewerAutoSuppressed) set({ viewerAutoSuppressed: false });
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
      // 共享会话：消息里的 att: 引用必须就绪再发——先等本会话所有在途上传
      // 完成（上传失败的附件已被 addAttachments 移除，不会进消息），避免
      // "消息快于文件"让宿主读到发送方本机才有的路径。非共享会话无此问题
      // （引擎执行面在本机，路径直接可用）。
      if (sharedView || attachments.some((a) => a.ref)) {
        await waitAttachments(sid);
      }
      // 共享会话：重新读一次附件（upload 完成 ref 已挂上；上传失败项已被
      // 移除，这里兜底过滤掉 ref 为空的项，绝不带本地路径跨机）。
      const finalAttachments = (sharedView ? attachments.filter((a) => !!a.ref) : attachments).filter(
        (a) => !!a.path && (a.ref || !sharedView),
      );
      const lines = finalAttachments.map((a) => `[附件] ${a.name} → ${a.ref ?? a.path}`);
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
          // 走 transientError：链路恢复（下一条消息送达/重连）即
          // 撤销——常驻 error 区只服务「需要人工处理」的事。
          transientError: t("err.sendTimeout"),
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
          // 失败时附件放回该会话（成功发送时已清）。放回 finalAttachments
          // （过滤后，不含上传失败被移除的项），已移除项不再复活。
          attachments: {
            ...s.attachments,
            [sid]: [...(s.attachments[sid] ?? []), ...finalAttachments],
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
      // 重新生成同样是新回合：恢复自动弹出资格。
      if (get().viewerAutoSuppressed) set({ viewerAutoSuppressed: false });
      // 服务端从落库历史取最后一条用户消息原文重发（不追加新块）。
      // busy 由 result/error 复位；断线重连路径里也会复位。
      sendJson({ type: "regenerate", session_id: currentSessionId });
      set((s) => ({ busy: { ...s.busy, [currentSessionId]: true } }));
    },

    recallMessage(sessionId, ordinal, prefix) {
      const { wsStatus } = get();
      if (!socketOpen() || wsStatus !== "connected") {
        set({ error: t("err.offline") });
        return;
      }
      // 撤回成功/失败都由服务端结算：成功推 history_truncated（整表替换），
      // 失败推 error（含 busy/deny/stale/定位失败）→ 客户端按码走轻提示。
      // busy 不在前端预拦：报错回执统一由服务端给，避免两处文案漂移。
      sendJson({ type: "recall_message", session_id: sessionId, ordinal, prefix });
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
      // 粘贴的截图等临时文件（Windows 上 Electron pathForFile 会指向
      // %TEMP% 下的临时副本）在主进程 read-bytes 只放行「附件目录内或本
      // 会话已标记」——把本次添加的路径现在就标记（用户主动添加即意图，
      // 与发送时 markAttachments 同一语义），避免后台上传被守卫拒绝而
      // 让消息退回本地 temp 路径（跨机必读不到）。
      void window.blm.markAttachments(sid, items.map((x) => x.path));
      // 共享会话/协作线程：挑选/粘贴时即后台上传服务端托管，引用挂到
      // 附件条目（发送时行里直接用）。失败只提示不打断——发送时该条
      // 退回本地路径行，用户可重试（删掉重贴）。
      const { serverUrl, token, sessions, sharedSessions, sharedView } = get();
      const meta =
        sessions.find((x) => x.session_id === sid) ??
        sharedSessions.find((x) => x.session_id === sid);
      const isShared =
        !!sharedView || meta?.shared === true || (meta?.shared_with?.length ?? 0) > 0;
      if (!isShared) return;
      for (const item of items) {
        const key = `${sid}::${item.path}`;
        const p = (async () => {
          try {
            const r = await window.blm.readAttachmentBytes(sid, item.path);
            if (!r.base64) throw new Error(r.error ?? "read failed");
            const ref = await uploadAttachment(
              serverUrl,
              token ?? "",
              sid,
              r.name ?? item.name,
              r.base64,
            );
            set((s) => ({
              attachments: {
                ...s.attachments,
                [sid]: (s.attachments[sid] ?? []).map((x) =>
                  x.path === item.path ? { ...x, ref } : x,
                ),
              },
            }));
          } catch {
            // 上传失败：从会话附件里移除该项，避免发送时回落本地路径
            // 让宿主读到不可达文件。提示后用户可重试（删掉重贴）。
            set((s) => ({
              attachments: {
                ...s.attachments,
                [sid]: (s.attachments[sid] ?? []).filter((x) => x.path !== item.path),
              },
              transientError: t("err.attachUploadFail"),
            }));
          } finally {
            pendingUploads.delete(key);
          }
        })();
        pendingUploads.set(key, p);
      }
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
