import type { ServerMessage } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { wsBase } from "../http";
import {
  isClosedByUser,
  nextReconnectDelay,
  resetReconnect,
  resetReconnectAttempt,
  setClosedByUser,
  setReconnectTimer,
  setSocket,
  currentSocket,
  startHeartbeat,
  stopHeartbeat,
  markSocketAlive,
  isActiveSocket,
  failPendingAcks,
} from "../socket";
import { handleMessage } from "../messages";
import { t } from "../../i18n";

export function createConnectionActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "connect"> {
  return {
    connect() {
      const { token } = get();
      const serverUrl = get().serverUrl;
      if (!token || !serverUrl) return;
      const existing = currentSocket();
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      resetReconnect();
      // 主动登录是新会话的开始：复位 logout 置位的标志，恢复断线自动重连。
      setClosedByUser(false);
      const ws = new WebSocket(`${wsBase(serverUrl)}/ws?token=${encodeURIComponent(token)}`);
      setSocket(ws);
      set({ wsStatus: "connecting" });

      // 断链统一处理：onclose 与心跳判死共用。带陈旧连接守卫；两者都触发时
      // connect() 的 OPEN/CONNECTING 守卫保证只会真正重连一次。
      const onLinkDead = (code: number, reason: string): void => {
        if (!isActiveSocket(ws)) return;
        stopHeartbeat();
        set({ wsStatus: "disconnected" });
        if (isClosedByUser()) return;
        // 服务端主动拒绝（token 失效/禁用/未过审）：登出回登录屏并说明原因，不再重连。
        if (code === 4001 || code === 4003 || code === 4004) {
          get().logout();
          set({
            authNotice:
              code === 4001
                ? t("li.expired")
                : code === 4003
                  ? t("li.disabled")
                  : reason === "review_rejected"
                    ? t("li.reviewRejected")
                    : t("li.reviewPending"),
          });
          return;
        }
        // 非正常断开：在途消息即刻判定失败（提示 + 文本放回输入框），不等超时。
        failPendingAcks();
        const delay = nextReconnectDelay();
        setReconnectTimer(setTimeout(() => get().connect(), delay));
      };

      ws.onopen = () => {
        resetReconnectAttempt();
        // 重连成功：清掉断线期间留下的「连接已断开，请稍后再发」类旧提示，
        // 否则恢复后聊天区还挂着过期报错。
        set({ wsStatus: "connected", error: null });
        startHeartbeat(ws, () => onLinkDead(4000, "heartbeat_timeout"));
        // 网络中继：把 serverUrl+JWT 下发给 main 进程（token 只存 main 内存，
        // 绝不写盘）。失败静默——中继是增强能力，不影响聊天主链路。
        void window.blm
          .relayConfigure({ server_url: serverUrl, token, enabled: true })
          .catch(() => undefined);
        // Sessions live inside project/default spaces and are created
        // explicitly — reconnecting just reloads what exists.
        void get().loadSessions().catch(() => undefined);
        // 断线期间的输出已落库：重连后重拉当前会话补齐历史，并复位可能
        // 卡死的 busy（result 恰好在断线窗口里送达时没人清它）。
        const sid = get().currentSessionId;
        if (sid) {
          set((s) => ({ busy: { ...s.busy, [sid]: false } }));
          // 共享视图保持只读跟进，不重拉（selectSession 会退出 sharedView）。
          if (!get().sharedView) void get().selectSession(sid).catch(() => undefined);
        }
        void get().loadProjects().catch(() => undefined);
        // Initial identity/presence snapshot; the WS `presence` events keep it fresh.
        void get().loadMe();
        void get().loadShared().then(() => {
          const snap: Record<string, boolean> = { ...get().presence };
          for (const s of get().sharedSessions) {
            if (s.owner) snap[s.owner] = s.owner_online ?? snap[s.owner] ?? false;
          }
          set({ presence: snap });
        });
        void get()
          .listUsers()
          .then((users) => {
            if (users.length === 0) return;
            const snap: Record<string, boolean> = { ...get().presence };
            for (const u of users) snap[u.username] = u.online;
            set({ presence: snap });
          });
        void get().loadLlmConfig();
      };
      ws.onclose = (ev) => onLinkDead(ev.code, ev.reason ?? "");
      ws.onerror = () => {
        if (!isActiveSocket(ws)) return;
        stopHeartbeat();
        set({ wsStatus: "disconnected" });
      };
      ws.onmessage = (ev) => {
        if (!isActiveSocket(ws)) return;
        markSocketAlive();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        handleMessage(msg, set, get);
      };
    },
  };
}
