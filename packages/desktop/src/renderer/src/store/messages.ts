import type { Block, ServerMessage } from "@blm/protocol";
import { normalizeExpr } from "../components/DragonflyLogo";
import { autoExecIfTrusted } from "./actions/chat";
import { clearSendAck, clearSendAckByText, pendingAcksForSession, sendExecResult, sendJson, socketOpen } from "./socket";
import { armTurn, finishTurn, notifyConfirmNeeded } from "./notify";
import { upsertSchedule } from "./actions/schedules";
import { t } from "../i18n";
import type { BlmState, GetState, SetState } from "./types";

/** Translate one server WS message into store mutations. */
export function handleMessage(msg: ServerMessage, set: SetState, get: GetState): void {
  // 链路活性证明：任何服务端帧都说明网络通了——
  // 「消息可能未送达」类横幅（transientError）就此撤销，
  // 不把过期报错一直挂在聊天区。
  if (get().transientError) set({ transientError: null });
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
        // 记回合开始（后台完成通知用；已在记的回合不重复记）。
        armTurn(msg.session_id);
      }
      if (msg.block.kind === "user_text" && msg.block.client_msg_id) {
        // 同 id 回显只认第一条（自动重发/断线重发时服务端幂等回显同一条）。
        // 已存在则整表替换（服务端权威），不追加——避免「同一发消息」
        // 因重连竞态在历史里出现两次。
        const cid = msg.block.client_msg_id;
        const sid = msg.session_id;
        const existing = (get().blocksBySession[sid] ?? []).some((b) => userTextIdOf(b) === cid);
        if (existing) {
          set((s) => ({
            blocksBySession: {
              ...s.blocksBySession,
              [sid]: (s.blocksBySession[sid] ?? []).map((b) =>
                userTextIdOf(b) === cid ? msg.block : b,
              ),
            },
          }));
          break;
        }
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

    case "history_truncated":
      // 撤回消息后的全量补发：整表替换本地缓存（服务端权威），并清掉
      // 该会话的流式残影与忙碌态（撤回只在空闲时被服务端接受）。
      set((s) => ({
        blocksBySession: { ...s.blocksBySession, [msg.session_id]: msg.blocks },
        streaming: { ...s.streaming, [msg.session_id]: "" },
        busy: { ...s.busy, [msg.session_id]: false },
      }));
      break;

    case "permission_request":
      // 信任模式：引擎侧确认（外部 MCP 工具走这条流）也全免——直接应允，
      // 不进弹窗队列。与本机执行的 autoExecIfTrusted 同一语义：信任模式 =
      // 全自主运行（引擎原生工具在服务端被直接拒绝，从不产生此帧，无豁口）。
      if (get().trustMode && socketOpen()) {
        sendJson({ type: "permission_response", request_id: msg.request_id, allow: true });
        break;
      }
      // 并发审批：追加进队列（弹窗渲染队首，逐个应答）。
      set((s) => ({ pendingPermission: [...s.pendingPermission, msg] }));
      // 失焦时系统通知提醒（前台正看着就不打扰）。
      notifyConfirmNeeded(msg.session_id, get);
      break;

    case "tool_exec_request": {
      // 工作目录/空间设置只能用户在界面里改：任何经对话进来的
      // 改目录请求一律拒绝回执，绝不转发主进程。运行时字符串
      // 比较（帧未经 schema 校验，旧服务端帧兜底）。
      if ((msg.action as string) === "choose_workdir") {
        sendExecResult(msg.request_id, {
          ok: false,
          error: t("err.workdirUiOnly"),
        });
        break;
      }
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
      if (!handled) {
        set((s) => ({ pendingExec: [...s.pendingExec, msg] }));
        // 失焦时系统通知提醒（信任模式自动执行的请求不弹）。
        notifyConfirmNeeded(msg.session_id, get);
      }
      break;
    }

    case "result":
      // 引擎命令队列里还有用户消息（回合中补充的内容没被本回合并入）时还会
      // 继续出结果：保持 busy，输入框不切回「发送」（否则用户以为已空闲）。
      // 本机还有消息在等送达确认时同理（服务端还没接手，不能解锁）。
      const keepBusy =
        (msg.queued_turn_count ?? 0) > 0 || pendingAcksForSession(msg.session_id) > 0;
      set((s) => ({
        busy: {
          ...s.busy,
          [msg.session_id]: keepBusy,
        },
        streaming: { ...s.streaming, [msg.session_id]: "" },
        // 本会话成功跑完一轮：早前挂在横幅上的报错（鉴权失败等）已过期——
        // 报错所指的问题恢复后横幅就该消失。失败回合的 result 不算数
        // （is_error=true，横幅描述的正是这一轮）。
        ...(s.error && s.errorSession === msg.session_id && !msg.is_error
          ? { error: null, errorCode: null, errorSession: null }
          : {}),
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
      // 失焦时系统通知「回复已完成」（排队续跑/还有在途消息时不通知，
      // 整串回复结束才提醒一次）。回合记账即消费。
      finishTurn(msg.session_id, get, false, !keepBusy);
      break;

    case "error":
      // 账号被管理员禁用：立即回到登录界面。
      if (msg.code === "account_disabled") {
        get().logout();
        set({ error: t("li.disabled"), errorCode: null, errorSession: null });
        break;
      }
      // 被管理员强制下线（账号未禁用，可重新登录）。
      if (msg.code === "kicked") {
        get().logout();
        set({ authNotice: t("li.kicked") });
        break;
      }
      // 撤回类回执（忙/无权/过期/定位失败）：动作反馈，不是会话级错误——
      // 走数秒自动消失的轻提示。常驻横幅是全局状态、只在同一会话成功
      // 跑完一轮后才撤，撤回失败挂上去会在所有会话里持续显示（实测踩过）。
      if (msg.code.startsWith("recall_")) {
        showNotice(set, msg.message);
        break;
      }
      set((s) => ({
        error: msg.message,
        // 记下横幅来源：该会话下一轮成功跑完时据此撤掉（恢复不再粘着）。
        errorCode: msg.code,
        errorSession: msg.session_id,
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
      // 回合失败也算回合完成（失焦时系统通知）；无 session_id 的
      // 全局性错误没有会话可跳，不打扰。
      if (msg.session_id) finishTurn(msg.session_id, get, true);
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
          // 横幅被借用为轻提示：来源标识一并清掉，别替旧错误背书。
          errorCode: null,
          errorSession: null,
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
          // 同上：借用横幅时不留来源标识（保持原有错误则原样保留标识）。
          ...(mine ? { errorCode: null, errorSession: null } : {}),
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

    case "task_gone":
      // 任务记录被需求方删除：协作端列表同步摘除条目。
      set((s) => ({
        tasks: s.tasks.filter((x) => x.task_id !== msg.task_id),
      }));
      break;

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

    case "turn_state":
      // 服务端权威的忙闲状态（共享会话由别人驱动时也能看到忙碌）。
      // 会话是自己的且消息由本回合回显驱动时，本地已置 busy=true——
      // 两者一致，直接覆盖不会闪回空闲。本地 busy 只有发送者会置，
      // 其它会话（后台会话、共享会话）一律信服务端。
      set((s) => ({ busy: { ...s.busy, [msg.session_id]: msg.busy } }));
      break;

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

    case "session_unshared":
      // 主人取消共享 / 删除了共享会话：从共享列表摘除。会话数据对我不再
      // 可读——共享 tab 一并关掉（正在查看的连同 sharedView 一起退），
      // 免得留下一个点不进去的挂空 tab。closeTab 对未打开的 id 是 no-op。
      set((s) => ({
        sharedSessions: s.sharedSessions.filter((x) => x.session_id !== msg.session_id),
      }));
      // 只关共享 tab（自有会话 tab 同 id 不应被误关；这里字段隔离）。
      if (get().openTabs.includes(msg.session_id)) {
        get().closeTab(msg.session_id);
        // closeTab 在关当前 tab 时已换焦点，但 sharedView 复位在 set 之外：
        // 若被关的就是当前共享视图，须保证 sharedView 已为 false。
        if (get().currentSessionId === msg.session_id) {
          set({ sharedView: false });
        }
      }
      break;

    case "review_request":
      // 新注册待审核（或上线补推）：更新角标数。
      set({ pendingReviewCount: msg.pending });
      break;

    case "presence":
      set((s) => ({ presence: { ...s.presence, [msg.user_id]: msg.online } }));
      break;

    case "diag_request":
      // 显示诊断：采集布局摘要（+ 允许时的截图）回服务端。
      // 不弹窗不提示——摘要纯几何数字；截图有独立开关把关。
      void get().collectDiag(msg.request_id, msg.scope);
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

/** 各块里取的送达确认 id（仅 user_text 有；其它块统一返回 undefined）。 */
function userTextIdOf(b: Block): string | undefined {
  return b.kind === "user_text" ? b.client_msg_id : undefined;
}

export type { BlmState };
