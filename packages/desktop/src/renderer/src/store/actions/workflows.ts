import type { UpsertWorkflowRequest, WorkflowsResponse } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

// 工作流模板管理。用户级走 /api/workflows/*，全局（管理员）走
// /api/admin/workflows/*。与 actions/skills.ts 同构：服务端错误码映射为
// 已翻译文案后抛出，由设置面板展示。

function errorText(code: string): string {
  switch (code) {
    case "invalid_name":
      return t("wf.errReserved");
    case "invalid_request":
      return t("wf.errStage");
    case "forbidden":
      return t("wf.errForbidden");
    case "not_found":
      return t("wf.errNotFound");
    default:
      return t("wf.saveFail");
  }
}

async function request(
  serverUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${apiBase(serverUrl)}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token ?? ""}`,
    },
  });
  if (!res.ok) {
    let code = "";
    try {
      code = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // non-JSON error body — fall through to generic text
    }
    throw new Error(errorText(code));
  }
  return res.status === 204 ? null : res.json();
}

export function createWorkflowActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "loadWorkflows"
  | "saveWorkflow"
  | "deleteWorkflow"
  | "loadGlobalWorkflows"
  | "saveGlobalWorkflow"
  | "deleteGlobalWorkflow"
> {
  return {
    async loadWorkflows() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(serverUrl, token, "/api/workflows")) as WorkflowsResponse;
        set({ workflows: body.workflows });
      } catch {
        // offline — keep the last known list
      }
    },

    async saveWorkflow(name, body) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/workflows/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      await get().loadWorkflows();
    },

    async deleteWorkflow(name) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/workflows/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await get().loadWorkflows();
    },

    async loadGlobalWorkflows() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(serverUrl, token, "/api/admin/workflows")) as WorkflowsResponse;
        set({ globalWorkflows: body.workflows });
      } catch {
        // offline / non-admin — keep the last known list
      }
    },

    async saveGlobalWorkflow(name, body) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/admin/workflows/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      await get().loadGlobalWorkflows();
    },

    async deleteGlobalWorkflow(name) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/admin/workflows/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await get().loadGlobalWorkflows();
    },
  };
}
