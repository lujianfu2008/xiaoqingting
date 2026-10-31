import type {
  ImportMcpResult,
  McpRegistrySearchResponse,
  McpServerDef,
  McpServerInfo,
  McpServersResponse,
} from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

// MCP 服务器管理。用户级走 /api/mcp/*，全局（管理员）走 /api/admin/mcp/*。
// 服务端错误码映射为已翻译文案后抛出，由设置面板展示。

function errorText(code: string): string {
  switch (code) {
    case "private_url":
      return t("mcp.errPrivateUrl");
    case "unresolvable_host":
      return t("mcp.errUnresolvable");
    case "invalid_url":
      return t("mcp.errInvalidUrl");
    case "stdio_forbidden":
      return t("mcp.errStdio");
    case "reserved_name":
    case "invalid_name":
      return t("mcp.errInvalidName");
    case "invalid_request":
    case "invalid_json":
      return t("mcp.errInvalid");
    case "registry_unreachable":
      return t("mcp.registryFail");
    case "forbidden":
      return t("mcp.errForbidden");
    case "not_found":
      return t("mcp.errNotFound");
    default:
      return t("mcp.saveFail");
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

export function createMcpActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "loadMcpServers"
  | "saveMcpServer"
  | "deleteMcpServer"
  | "importMcpServers"
  | "searchMcpRegistry"
  | "loadGlobalMcpServers"
  | "saveGlobalMcpServer"
  | "deleteGlobalMcpServer"
  | "importGlobalMcpServers"
> {
  return {
    async searchMcpRegistry(q, cursor) {
      const { serverUrl, token } = get();
      const params = new URLSearchParams({ q });
      if (cursor) params.set("cursor", cursor);
      return (await request(
        serverUrl,
        token,
        `/api/mcp/registry/search?${params.toString()}`,
      )) as McpRegistrySearchResponse;
    },

    async loadMcpServers() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(serverUrl, token, "/api/mcp/servers")) as McpServersResponse;
        set({ mcpServers: body.servers });
      } catch {
        // offline — keep the last known list
      }
    },

    async saveMcpServer(name, def) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(def),
      });
      await get().loadMcpServers();
    },

    async deleteMcpServer(name) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await get().loadMcpServers();
    },

    async importMcpServers(json) {
      const { serverUrl, token } = get();
      const result = (await request(serverUrl, token, "/api/mcp/import", {
        method: "POST",
        body: JSON.stringify({ json }),
      })) as ImportMcpResult;
      await get().loadMcpServers();
      return result;
    },

    async loadGlobalMcpServers() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(
          serverUrl,
          token,
          "/api/admin/mcp/servers",
        )) as McpServersResponse;
        set({ globalMcpServers: body.servers });
      } catch {
        // offline / non-admin — keep the last known list
      }
    },

    async saveGlobalMcpServer(name, def) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/admin/mcp/servers/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(def),
      });
      await get().loadGlobalMcpServers();
    },

    async deleteGlobalMcpServer(name) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/admin/mcp/servers/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await get().loadGlobalMcpServers();
    },

    async importGlobalMcpServers(json) {
      const { serverUrl, token } = get();
      const result = (await request(serverUrl, token, "/api/mcp/import", {
        method: "POST",
        body: JSON.stringify({ json, scope: "global" }),
      })) as ImportMcpResult;
      await get().loadGlobalMcpServers();
      return result;
    },
  };
}
