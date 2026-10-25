import type { LlmConfigInfo } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

export function createLlmActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "loadLlmConfig" | "saveLlmConfig" | "clearLlmConfig"> {
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

    async saveLlmConfig(patch) {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/llm-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        throw new Error(
          res.status === 400 ? t("llm.badParams") : t("llm.saveFail"),
        );
      }
      const llmConfig = (await res.json()) as LlmConfigInfo;
      set({ llmConfig });
    },

    async clearLlmConfig() {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/llm-config`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(t("llm.resetFail"));
      set({ llmConfig: { configured: false } });
    },
  };
}
