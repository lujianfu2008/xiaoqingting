import type { LlmConfigInfo, LlmSettingsPatch, UpdateLlmProfileRequest } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

/** 大模型配置已落盘：挂着的「鉴权失败」横幅要求的事已办，立刻撤掉——
 *  服务端丢弃空闲会话后下一条消息即按新配置跑，横幅不必等重试成功。 */
function dismissAuthError(set: SetState, get: GetState): void {
  if (get().errorCode === "llm_auth") {
    set({ error: null, errorCode: null, errorSession: null });
  }
}

async function llmWrite(
  get: GetState,
  path: string,
  method: "PUT" | "POST" | "DELETE",
  body?: unknown,
): Promise<LlmConfigInfo> {
  const { serverUrl, token } = get();
  const res = await fetch(`${apiBase(serverUrl)}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    if (res.status === 400) throw new Error(t("llm.badParams"));
    if (res.status === 404) throw new Error(t("llm.notFound"));
    throw new Error(t("llm.saveFail"));
  }
  const info = (await res.json()) as LlmConfigInfo;
  return info;
}

export function createLlmActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "loadLlmConfig"
  | "saveLlmProfile"
  | "setLlmProfileEnabled"
  | "deleteLlmProfile"
  | "reorderLlmProfiles"
  | "saveLlmSettings"
  | "clearLlmConfig"
> {
  return {
    async loadLlmConfig() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/llm-config`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const llmConfig = (await res.json()) as LlmConfigInfo;
        set({ llmConfig });
      } catch {
        // offline — keep the last known config
      }
    },

    async saveLlmProfile(patch) {
      const info = await llmWrite(get, "/api/llm-config/profile", "PUT", patch);
      set({ llmConfig: info });
      dismissAuthError(set, get);
    },

    async setLlmProfileEnabled(id, enabled) {
      const info = await llmWrite(get, `/api/llm-config/profile/${encodeURIComponent(id)}/enabled`, "POST", {
        enabled,
      });
      set({ llmConfig: info });
    },

    async deleteLlmProfile(id) {
      const info = await llmWrite(get, `/api/llm-config/profile/${encodeURIComponent(id)}`, "DELETE");
      set({ llmConfig: info });
    },

    async reorderLlmProfiles(ids) {
      const info = await llmWrite(get, "/api/llm-config/reorder", "POST", { ids });
      set({ llmConfig: info });
    },

    async saveLlmSettings(patch: LlmSettingsPatch) {
      const info = await llmWrite(get, "/api/llm-config/settings", "PUT", patch);
      set({ llmConfig: info });
      dismissAuthError(set, get);
    },

    async clearLlmConfig() {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/llm-config`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(t("llm.resetFail"));
      // 置空让面板回到「未配置」态；服务端默认策略在下次 loadLlmConfig 回填。
      set({ llmConfig: null });
      dismissAuthError(set, get);
    },
  };
}
