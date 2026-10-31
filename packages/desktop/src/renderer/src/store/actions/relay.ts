import type { MyRelayStatus, RelayConfigInfo, RelayConfigUpdate } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

// 网络中继的用户开关（GET/PUT /api/me/relay）与管理员配置
// （GET/PUT /api/admin/relay/config）。本地连接状态不在 REST 里——走 IPC。

export function createRelayActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "loadMyRelay" | "setMyRelayOptIn" | "loadAdminRelayConfig" | "saveAdminRelayConfig"> {
  return {
    async loadMyRelay() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/me/relay`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        set({ myRelay: (await res.json()) as MyRelayStatus });
      } catch {
        // offline — keep the last known state
      }
    },

    async setMyRelayOptIn(on) {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/me/relay`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ opt_in: on }),
      });
      if (!res.ok) throw new Error(t("relay.saveFail"));
      set({ myRelay: (await res.json()) as MyRelayStatus });
    },

    async loadAdminRelayConfig() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/relay/config`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        set({ adminRelayConfig: (await res.json()) as RelayConfigInfo });
      } catch {
        // offline — keep the last known config
      }
    },

    async saveAdminRelayConfig(patch: RelayConfigUpdate) {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/admin/relay/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(t("relay.saveFail"));
      set({ adminRelayConfig: (await res.json()) as RelayConfigInfo });
    },
  };
}
