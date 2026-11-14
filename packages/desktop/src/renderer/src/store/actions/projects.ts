import type { ProjectMeta } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";

// Project spaces: server-side grouping (projects + session membership). The
// local folder binding for each project lives only in the desktop main
// process, so creating a project here also triggers the bind flow over IPC.

export function createProjectActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "loadProjects" | "createProject" | "deleteProject" | "updateProjectDescription"> {
  return {
    async loadProjects() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/projects`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        // Old server without project endpoints: degrade to default space only.
        if (!res.ok) return;
        const projects = (await res.json()) as ProjectMeta[];
        set({ projects });
      } catch {
        // offline — keep the last list
      }
    },

    async createProject({ name, description, agentId, folder, visibility = "personal" }) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name,
            agent_id: agentId,
            ...(description?.trim() ? { description: description.trim() } : {}),
            ...(visibility === "public" ? { visibility } : {}),
          }),
        });
        if (!res.ok) return null;
        const project = (await res.json()) as ProjectMeta;
        // 公有域项目存放在服务端工作空间，不绑定本机文件夹。
        // Bind the local folder (native dialog, or auto-created subfolder of
        // the global work dir). Failure is non-fatal: the project stays
        // unbound and its sessions fall back to the global work dir until
        // the user binds one from the sidebar.
        if (visibility !== "public") {
          await window.blm.bindProjectFolder(project.project_id, {
            name: project.name,
            choose: folder === "choose",
          });
        }
        set((s) => ({ projects: [...s.projects, project] }));
        return project;
      } catch {
        return null;
      }
    },

    async deleteProject(id) {
      const { serverUrl, token } = get();
      await fetch(`${apiBase(serverUrl)}/api/projects/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      // The server has demoted the project's sessions to the default space;
      // mirror that locally. The on-disk folder and the stale settings entry
      // are left untouched (the entry simply never matches again).
      set((s) => ({
        projects: s.projects.filter((p) => p.project_id !== id),
        sessions: s.sessions.map((x) => (x.project_id === id ? { ...x, project_id: null } : x)),
      }));
    },

    /** 设置项目描述（个人=本人；公域=管理员）；空串 = 清空。 */
    async updateProjectDescription(id, description) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/projects/${id}/description`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ description }),
        });
        if (!res.ok) return false;
        const rec = (await res.json()) as { description?: string };
        set((s) => ({
          projects: s.projects.map((p) =>
            p.project_id === id ? { ...p, description: rec.description || undefined } : p,
          ),
        }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
