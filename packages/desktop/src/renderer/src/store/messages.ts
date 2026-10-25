import type { ServerMessage } from "@blm/protocol";
import { normalizeExpr } from "../components/DragonflyLogo";
import { autoExecIfTrusted } from "./actions/chat";
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
      set((s) => ({
        blocksBySession: {
          ...s.blocksBySession,
          [msg.session_id]: [...(s.blocksBySession[msg.session_id] ?? []), msg.block],
        },
        // final text block replaces the streamed preview to avoid duplication
        streaming:
          msg.block.kind === "text" ? { ...s.streaming, [msg.session_id]: "" } : s.streaming,
      }));
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
      set({ pendingPermission: msg });
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
      if (!handled) set({ pendingExec: msg });
      break;
    }

    case "result":
      set((s) => ({
        busy: { ...s.busy, [msg.session_id]: false },
        streaming: { ...s.streaming, [msg.session_id]: "" },
      }));
      // Fallback: reply ended without an emotion tag → a small happy nod
      if (get().expr === "normal") get().setExpr("happy", 1800);
      break;

    case "error":
      // 账号被管理员禁用：立即回到登录界面。
      if (msg.code === "account_disabled") {
        get().logout();
        set({ error: t("li.disabled") });
        break;
      }
      set((s) => ({
        error: msg.message,
        busy: msg.session_id ? { ...s.busy, [msg.session_id]: false } : s.busy,
      }));
      get().setExpr("sad", 3000);
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

    case "presence":
      set((s) => ({ presence: { ...s.presence, [msg.user_id]: msg.online } }));
      break;

    case "pong":
      break;
  }
}

export type { BlmState };
