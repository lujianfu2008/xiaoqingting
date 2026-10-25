import type { ServerMessage } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { wsBase } from "../http";
import {
  isClosedByUser,
  nextReconnectDelay,
  resetReconnect,
  resetReconnectAttempt,
  setReconnectTimer,
  setSocket,
  currentSocket,
} from "../socket";
import { handleMessage } from "../messages";

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
      const ws = new WebSocket(`${wsBase(serverUrl)}/ws?token=${encodeURIComponent(token)}`);
      setSocket(ws);
      set({ wsStatus: "connecting" });

      ws.onopen = () => {
        resetReconnectAttempt();
        set({ wsStatus: "connected" });
        // Sessions live inside project/default spaces and are created
        // explicitly — reconnecting just reloads what exists.
        void get().loadSessions().catch(() => undefined);
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
      ws.onclose = () => {
        set({ wsStatus: "disconnected" });
        if (isClosedByUser()) return;
        const delay = nextReconnectDelay();
        setReconnectTimer(setTimeout(() => get().connect(), delay));
      };
      ws.onerror = () => set({ wsStatus: "disconnected" });
      ws.onmessage = (ev) => {
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
