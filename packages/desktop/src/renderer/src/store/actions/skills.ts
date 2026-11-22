import type {
  ImportSkillsResult,
  SkillMarkdownResponse,
  SkillRegistrySearchResponse,
  SkillsResponse,
} from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { getMarketLang } from "../../lib/marketLang";
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
    case "bad_archive":
      return t("skills.errArchive");
    case "no_skills":
      return t("skills.errNoSkills");
    case "too_big":
      return t("skills.errTooBig");
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

/** File → base64（分块拼接避免 call 栈爆掉）。 */
export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    bin += String.fromCharCode(...buf.subarray(i, i + CH));
  }
  return btoa(bin);
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
  | "readSkill"
  | "setSkillEnabled"
  | "importSkills"
  | "importSkillsArchive"
  | "installSkill"
  | "searchSkillRegistry"
  | "loadGlobalSkills"
  | "saveGlobalSkill"
  | "deleteGlobalSkill"
  | "readGlobalSkill"
  | "setGlobalSkillEnabled"
  | "importGlobalSkills"
  | "importGlobalSkillsArchive"
  | "installGlobalSkill"
> {
  return {
    async searchSkillRegistry(q) {
      const { serverUrl, token } = get();
      const params = new URLSearchParams({ q, lang: getMarketLang() });
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
        const params = new URLSearchParams({ lang: getMarketLang() });
        const body = (await request(
          serverUrl,
          token,
          `/api/skills?${params.toString()}`,
        )) as SkillsResponse;
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

    async readSkill(name) {
      const { serverUrl, token } = get();
      const body = (await request(
        serverUrl,
        token,
        `/api/skills/${encodeURIComponent(name)}`,
      )) as SkillMarkdownResponse;
      return body.markdown;
    },

    async setSkillEnabled(name, enabled) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/skills/${encodeURIComponent(name)}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
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
      const body = (await request(serverUrl, token, "/api/skills/install", {
        method: "POST",
        body: JSON.stringify({ name, url }),
      })) as { ok?: boolean; name?: string };
      await get().loadSkills();
      return body;
    },

    async importSkillsArchive(archiveBase64, filename) {
      const { serverUrl, token } = get();
      const result = (await request(serverUrl, token, "/api/skills/import-archive", {
        method: "POST",
        body: JSON.stringify({ archive: archiveBase64, filename }),
      })) as ImportSkillsResult;
      await get().loadSkills();
      return result;
    },

    async loadGlobalSkills() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const params = new URLSearchParams({ lang: getMarketLang() });
        const body = (await request(
          serverUrl,
          token,
          `/api/admin/skills?${params.toString()}`,
        )) as SkillsResponse;
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

    async readGlobalSkill(name) {
      const { serverUrl, token } = get();
      const body = (await request(
        serverUrl,
        token,
        `/api/admin/skills/${encodeURIComponent(name)}`,
      )) as SkillMarkdownResponse;
      return body.markdown;
    },

    async setGlobalSkillEnabled(name, enabled) {
      const { serverUrl, token } = get();
      await request(
        serverUrl,
        token,
        `/api/admin/skills/${encodeURIComponent(name)}/enabled`,
        {
          method: "POST",
          body: JSON.stringify({ enabled }),
        },
      );
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
      const body = (await request(serverUrl, token, "/api/skills/install", {
        method: "POST",
        body: JSON.stringify({ name, url, scope: "global" }),
      })) as { ok?: boolean; name?: string };
      await get().loadGlobalSkills();
      return body;
    },

    async importGlobalSkillsArchive(archiveBase64, filename) {
      const { serverUrl, token } = get();
      const result = (await request(serverUrl, token, "/api/skills/import-archive", {
        method: "POST",
        body: JSON.stringify({ archive: archiveBase64, filename, scope: "global" }),
      })) as ImportSkillsResult;
      await get().loadGlobalSkills();
      return result;
    },
  };
}
