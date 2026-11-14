import { t } from "../i18n";
import type { GetState } from "./types";

// 后台完成通知：窗口失焦（后台/最小化/收进托盘）时，回合完成与
// 审批请求用系统通知提醒（preload window.blm.notify → 主进程
// Notification，点击聚焦并跳会话）。所有判定都在 renderer 完成，
// 主进程只负责弹。

// 每会话在记的回合：服务端回显用户消息时计时，
// result/error 到达时结算。值 = 回合开始时刻（epoch ms）。
const liveTurns = new Map<string, number>();

// 长回合保护：短于这个时长的完成不打扰（避免短问答刷屏）。
const TURN_MIN_MS = 8_000;

/** 服务端回显用户消息（回合开始）：记时刻，已在记不重复记。 */
export function armTurn(sessionId: string): void {
  const now = Date.now();
  // 兜底清理：回合异常中断（断线后没人结算）会留下旧记录，
  // 超 10 分钟直接丢弃，Map 不无限涨。
  if (liveTurns.size > 50) {
    for (const [sid, at] of liveTurns) {
      if (now - at > 600_000) liveTurns.delete(sid);
    }
  }
  if (!liveTurns.has(sessionId)) liveTurns.set(sessionId, now);
}

/**
 * 回合结束（result/error）：失焦且回合持续超过长回合阈值时弹通知。
 * 没记到开始时刻（无用户消息回显、纯短错误）或太短都不打扰；
 * 记录即消费，同一回合不重复通知。final=false 表示引擎队列里
 * 还有续跑的回合（整串回复没完），此时重新计时、不通知。
 */
export function finishTurn(
  sessionId: string,
  get: GetState,
  isError: boolean,
  final = true,
): void {
  const armedAt = liveTurns.get(sessionId);
  if (!final) {
    // 续跑回合：保留原起点（整串回复的总时长继续累计），不通知。
    if (armedAt === undefined) liveTurns.set(sessionId, Date.now());
    return;
  }
  liveTurns.delete(sessionId);
  if (armedAt === undefined || Date.now() - armedAt < TURN_MIN_MS) return;
  notifySession(sessionId, get, t(isError ? "notify.turnFailed" : "notify.turnDone"));
}

/** 审批/本机执行确认请求到达（未信任模式）：失焦时提醒。 */
export function notifyConfirmNeeded(sessionId: string, get: GetState): void {
  notifySession(sessionId, get, t("notify.needConfirm"));
}

function notifySession(sessionId: string, get: GetState, body: string): void {
  const s = get();
  if (!s.notifyEnabled) return;
  // 前台聚焦中不弹（用户正看着窗口）。
  if (document.hasFocus()) return;
  // 标题用会话标题，找不到（共享列表未同步等）退回智能体名。
  const session =
    s.sessions.find((x) => x.session_id === sessionId) ??
    s.sharedSessions.find((x) => x.session_id === sessionId);
  const agentName = session
    ? s.agents.find((a) => a.agent_id === session.agent_id)?.name
    : undefined;
  void window.blm
    .notify({ title: session?.title ?? agentName ?? t("side.defaultAgent"), body, session_id: sessionId })
    .catch(() => undefined);
}
