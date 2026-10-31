import type {
  ImportSkillsResult,
  SkillRegistrySearchResponse,
  SkillsResponse,
} from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

// 专家技能管理。用户级走 /api/skills/*，全局（管理员）走 /api/admin/skills/*。
// 与 actions/mcp.ts 同构：服务端错误码映射为已翻译文案后抛出，由设置面板展示。

function errorText(code: string): string {
  switch (code) {
    case "invalid_name":
      return t("skills.errInvalidName");
    case "missing_frontmatter":
      return t("skills.errFrontmatter");
    case "too_large":
      return t("skills.errTooLarge");
    case "download_failed":
      return t("skills.errDownload");
    case "invalid_request":
    case "invalid_json":
      return t("skills.errInvalid");
    case "registry_unconfigured":
      return t("skills.registryUnset");
    case "registry_unreachable":
      return t("skills.registryFail");
    case "forbidden":
      return t("skills.errForbidden");
    case "not_found":
      return t("skills.errNotFound");
    default:
      return t("skills.saveFail");
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

export function createSkillActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "loadSkills"
  | "saveSkill"
  | "deleteSkill"
  | "importSkills"
  | "installSkill"
  | "searchSkillRegistry"
  | "loadGlobalSkills"
  | "saveGlobalSkill"
  | "deleteGlobalSkill"
  | "importGlobalSkills"
  | "installGlobalSkill"
> {
  return {
    async searchSkillRegistry(q) {
      const { serverUrl, token } = get();
      const params = new URLSearchParams({ q });
      return (await request(
        serverUrl,
        token,
        `/api/skills/registry/search?${params.toString()}`,
      )) as SkillRegistrySearchResponse;
    },

    async loadSkills() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(serverUrl, token, "/api/skills")) as SkillsResponse;
        set({ skills: body.skills });
      } catch {
        // offline — keep the last known list
      }
    },

    async saveSkill(name, markdown) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ markdown }),
      });
      await get().loadSkills();
    },

    async deleteSkill(name) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await get().loadSkills();
    },

    async importSkills(json) {
      const { serverUrl, token } = get();
      const result = (await request(serverUrl, token, "/api/skills/import", {
        method: "POST",
        body: JSON.stringify({ json }),
      })) as ImportSkillsResult;
      await get().loadSkills();
      return result;
    },

    async installSkill(name, url) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, "/api/skills/install", {
        method: "POST",
        body: JSON.stringify({ name, url }),
      });
      await get().loadSkills();
    },

    async loadGlobalSkills() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(serverUrl, token, "/api/admin/skills")) as SkillsResponse;
        set({ globalSkills: body.skills });
      } catch {
        // offline / non-admin — keep the last known list
      }
    },

    async saveGlobalSkill(name, markdown) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/admin/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ markdown }),
      });
      await get().loadGlobalSkills();
    },

    async deleteGlobalSkill(name) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/admin/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await get().loadGlobalSkills();
    },

    async importGlobalSkills(json) {
      const { serverUrl, token } = get();
      const result = (await request(serverUrl, token, "/api/skills/import", {
        method: "POST",
        body: JSON.stringify({ json, scope: "global" }),
      })) as ImportSkillsResult;
      await get().loadGlobalSkills();
      return result;
    },

    async installGlobalSkill(name, url) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, "/api/skills/install", {
        method: "POST",
        body: JSON.stringify({ name, url, scope: "global" }),
      });
      await get().loadGlobalSkills();
    },
  };
}
