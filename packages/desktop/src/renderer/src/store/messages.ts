import type { ServerMessage } from "@blm/protocol";
import { normalizeExpr } from "../components/DragonflyLogo";
import { autoExecIfTrusted } from "./actions/chat";
import { clearSendAck, clearSendAckByText, pendingAcksForSession } from "./socket";
import { upsertSchedule } from "./actions/schedules";
import { t } from "../i18n";
import type { BlmState, GetState, SetState } from "./types";

/** Translate one server WS message into store mutations. */
export function handleMessage(msg: ServerMessage, set: SetState, get: GetState): void {
  switch (msg.type) {
    case "message_delta":
      set((s) => ({
        streaming: {
          ...s.streaming,
          [msg.session_id]: (s.streaming[msg.session_id] ?? "") + msg.delta,
        },
      }));
      break;

    case "message_block":
      // 自己发出的 user_text 回到界面上 = 服务端已收到，解除该条的发送确认。
      // 按 client_msg_id 精确解除；老服务端不回显 id 时按文本兜底匹配。
      if (msg.block.kind === "user_text") {
        if (msg.block.client_msg_id) clearSendAck(msg.block.client_msg_id);
        else clearSendAckByText(msg.session_id, msg.block.text);
      }
      set((s) => ({
        blocksBySession: {
          ...s.blocksBySession,
          [msg.session_id]: [...(s.blocksBySession[msg.session_id] ?? []), msg.block],
        },
        // final text block replaces the streamed preview to avoid duplication
        streaming:
          msg.block.kind === "text" ? { ...s.streaming, [msg.session_id]: "" } : s.streaming,
      }));
      // 朗读/表情只跟随当前正查看的会话：后台会话的回复不读、不驱动表情。
      if (msg.session_id !== get().currentSessionId) break;
      // Auto-read final assistant text when enabled
      if (msg.block.kind === "text" && get().autoRead && msg.block.text.trim()) {
        get().speak(msg.block.text);
      }
      // Emotion tag from the server drives the avatar expression
      if (msg.block.kind === "text" && msg.block.emotion) {
        get().setExpr(normalizeExpr(msg.block.emotion));
      }
      break;

    case "permission_request":
      // 并发审批：追加进队列（弹窗渲染队首，逐个应答）。
      set((s) => ({ pendingPermission: [...s.pendingPermission, msg] }));
      break;

    case "tool_exec_request": {
      const handled = autoExecIfTrusted(
        {
          request_id: msg.request_id,
          action: msg.action,
          params: msg.params as Record<string, unknown>,
          // Trust mode must pass the session through: the executor derives the
          // work dir, project read scope and attachment marks from it. The
          // manual-confirm path (respondExec) already does.
          session_id: msg.session_id,
        },
        get().trustMode,
      );
      if (!handled) set((s) => ({ pendingExec: [...s.pendingExec, msg] }));
      break;
    }

    case "result":
      // 引擎命令队列里还有用户消息（回合中补充的内容没被本回合并入）时还会
      // 继续出结果：保持 busy，输入框不切回「发送」（否则用户以为已空闲）。
      // 本机还有消息在等送达确认时同理（服务端还没接手，不能解锁）。
      set((s) => ({
        busy: {
          ...s.busy,
          [msg.session_id]:
            (msg.queued_turn_count ?? 0) > 0 || pendingAcksForSession(msg.session_id) > 0,
        },
        streaming: { ...s.streaming, [msg.session_id]: "" },
        // 回合结束，该会话还挂着的审批/执行请求已过时：清掉，弹窗不残留。
        pendingPermission: s.pendingPermission.filter((r) => r.session_id !== msg.session_id),
        pendingExec: s.pendingExec.filter((r) => r.session_id !== msg.session_id),
        // 本回复用量 + 会话累计（服务端落库；本地同步累加避免整表刷新）。
        usageBySession: msg.usage
          ? { ...s.usageBySession, [msg.session_id]: msg.usage }
          : s.usageBySession,
        sessions: msg.usage
          ? s.sessions.map((x) =>
              x.session_id === msg.session_id
                ? {
                    ...x,
                    usage: {
                      input_tokens: (x.usage?.input_tokens ?? 0) + msg.usage!.input_tokens,
                      output_tokens: (x.usage?.output_tokens ?? 0) + msg.usage!.output_tokens,
                      cost_usd:
                        x.usage?.cost_usd != null || msg.usage!.cost_usd != null
                          ? (x.usage?.cost_usd ?? 0) + (msg.usage!.cost_usd ?? 0)
                          : null,
                    },
                  }
                : x,
            )
          : s.sessions,
      }));
      // Fallback: reply ended without an emotion tag → a small happy nod
      // （只对当前会话：后台会话跑完不驱动表情）
      if (msg.session_id === get().currentSessionId && get().expr === "normal") {
        get().setExpr("happy", 1800);
      }
      break;

    case "error":
      // 账号被管理员禁用：立即回到登录界面。
      if (msg.code === "account_disabled") {
        get().logout();
        set({ error: t("li.disabled") });
        break;
      }
      // 被管理员强制下线（账号未禁用，可重新登录）。
      if (msg.code === "kicked") {
        get().logout();
        set({ authNotice: t("li.kicked") });
        break;
      }
      set((s) => ({
        error: msg.message,
        busy: msg.session_id ? { ...s.busy, [msg.session_id]: false } : s.busy,
        // 出错会话的待审批/待执行请求一并清掉（弹窗不残留）。
        pendingPermission: msg.session_id
          ? s.pendingPermission.filter((r) => r.session_id !== msg.session_id)
          : s.pendingPermission,
        pendingExec: msg.session_id
          ? s.pendingExec.filter((r) => r.session_id !== msg.session_id)
          : s.pendingExec,
      }));
      // 表情只跟随当前会话（或全局性错误）；后台会话报错只弹提示不变脸。
      if (!msg.session_id || msg.session_id === get().currentSessionId) {
        get().setExpr("sad", 3000);
      }
      break;

    case "update_request":
      // 收到新的公有域更新申请（管理员视角为主）：合并进列表并提示。
      set((s) => {
        const exists = s.updateRequests.some((r) => r.request_id === msg.request.request_id);
        return {
          updateRequests: exists
            ? s.updateRequests.map((r) => (r.request_id === msg.request.request_id ? msg.request : r))
            : [msg.request, ...s.updateRequests],
          error: t("ur.newRequest", { requester: msg.request.requester }),
        };
      });
      break;

    case "update_request_decided":
      // 申请有了结果：刷新列表；若自己是申请人则明确提示。
      set((s) => {
        const exists = s.updateRequests.some((r) => r.request_id === msg.request.request_id);
        const mine = msg.request.requester === get().username;
        return {
          updateRequests: exists
            ? s.updateRequests.map((r) => (r.request_id === msg.request.request_id ? msg.request : r))
            : [msg.request, ...s.updateRequests],
          error: mine
            ? msg.request.status === "approved"
              ? t("ur.approvedToast", { path: msg.request.path })
              : t("ur.rejectedToast", { path: msg.request.path })
            : s.error,
        };
      });
      break;

    case "task_update": {
      // 协作流任务 upsert。只有内容有变化（或首见且我有角色）才轻提示：
      // 重连补推/REST 播种的内容与本地一致，不弹。
      const me = get().username;
      const prev = get().tasks.find((x) => x.task_id === msg.task.task_id);
      const changed =
        !prev || JSON.stringify(prev) !== JSON.stringify(msg.task);
      set((s) => {
        const exists = s.tasks.some((x) => x.task_id === msg.task.task_id);
        return {
          tasks: exists
            ? s.tasks.map((x) => (x.task_id === msg.task.task_id ? msg.task : x))
            : [msg.task, ...s.tasks],
        };
      });
      if (!changed || !me) break;
      const involved =
        msg.task.requester === me || msg.task.stages.some((s) => s.assignee === me);
      if (!involved) break;
      // 按优先级给出「需要我动作」的提示。走 notice（数秒自动消失）而非
      // error——error 是常驻横幅，任务提示挂在里面会永远粘在所有会话顶部。
      const toast = toastForTask(msg.task, me, prev);
      if (toast) showNotice(set, toast);
      break;
    }

    case "schedule_update": {
      // 定时任务 upsert（推送只发给任务主人本人）。会话首建/重建时服务端
      // 随帧携带 SessionMeta：自有会话的 session_created 分支只替换不追加，
      // 这里补足追加，让专属会话即时出现在侧边栏。
      const prev = get().schedules.find((x) => x.schedule_id === msg.schedule.schedule_id);
      upsertSchedule(msg.schedule, set);
      if (msg.session) {
        set((s) => {
          const exists = s.sessions.some((x) => x.session_id === msg.session!.session_id);
          return {
            sessions: exists
              ? s.sessions.map((x) =>
                  x.session_id === msg.session!.session_id ? msg.session! : x,
                )
              : [msg.session!, ...s.sessions],
          };
        });
      }
      // 首次见到或内容变化时轻提示「已触发」；重连播种/重复推送（内容相同）不弹。
      const changed = !prev || JSON.stringify(prev) !== JSON.stringify(msg.schedule);
      if (
        changed &&
        msg.schedule.last_result === "fired" &&
        (!prev || prev.last_result !== "fired")
      ) {
        showNotice(set, t("sc.firedToast", { name: msg.schedule.name }));
      }
      break;
    }

    case "session_created":
      if (msg.session.shared && msg.session.owner !== get().username) {
        // Someone's shared session got (re)named — refresh the shared list.
        set((s) => {
          const exists = s.sharedSessions.some((x) => x.session_id === msg.session.session_id);
          return {
            sharedSessions: exists
              ? s.sharedSessions.map((x) =>
                  x.session_id === msg.session.session_id ? msg.session : x,
                )
              : [msg.session, ...s.sharedSessions],
          };
        });
      } else {
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.session_id === msg.session.session_id ? msg.session : x,
          ),
        }));
      }
      break;

    case "review_request":
      // 新注册待审核（或上线补推）：更新角标数。
      set({ pendingReviewCount: msg.pending });
      break;

    case "presence":
      set((s) => ({ presence: { ...s.presence, [msg.user_id]: msg.online } }));
      break;

    case "pong":
      break;
  }
}

/** 任务轻提示的自动消失定时器（单槽位：新提示顶掉旧提示与其计时器）。 */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(set: SetState, text: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  set({ notice: text });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    set({ notice: null });
  }, 6000);
}

/** 任务变化时按我的角色挑一条「需要我动作」的轻提示（无则 null）。 */
function toastForTask(
  task: BlmState["tasks"][number],
  me: string,
  prev?: BlmState["tasks"][number],
): string | null {
  const title = task.title;
  if (task.status === "done") {
    return task.cancelled ? t("task.cancelledToast", { title }) : t("task.doneToast", { title });
  }
  const cur = task.stages.find((s) => s.key === task.current_stage);
  if (cur?.assignee === me) return t("task.yourTurnToast", { title, stage: cur.name });
  // 新被指派（此前我不在任务任何人名下，现在出现在某环节）：提示环节名。
  if (
    prev &&
    prev.requester !== me &&
    !prev.stages.some((s) => s.assignee === me) &&
    task.stages.some((s) => s.assignee === me)
  ) {
    const mine = task.stages.find((s) => s.assignee === me);
    if (mine) return t("task.assignedStageToast", { title, stage: mine.name });
  }
  return null;
}

export type { BlmState };
