import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Block, ProjectMeta, SessionMeta, UpdateRequestView } from "@blm/protocol";
import { config } from "./config.js";

// Session metadata + block history persistence (own storage, independent of the SDK).

export interface SessionRecord extends SessionMeta {
  user_id: string;
  cwd: string;
  engine_session_id: string | null;
  // Optional so session JSONs written before projects exist still parse.
  project_id?: string | null;
}

export interface ProjectRecord extends ProjectMeta {
  user_id: string;
}

/** 公有域更新申请（含待写入全文；对外只发 UpdateRequestView/Detail）。 */
export interface UpdateRequestRecord extends Omit<UpdateRequestView, "preview"> {
  content: string;
}

/** Server-side workspace root of a public project (never exposed to clients). */
export function publicProjectDir(projectId: string): string {
  return path.join(config.dataDir, "public-projects", projectId);
}

/** A shared session is visible to a user if shared_with is empty (everyone) or lists them. */
export function sharedWithUser(
  rec: Pick<SessionRecord, "shared_with">,
  userId: string,
): boolean {
  const list = rec.shared_with;
  return !list || list.length === 0 || list.includes(userId);
}

export class Store {
  private sessionPath(id: string): string {
    return path.join(config.dataDir, "sessions", `${id}.json`);
  }

  private historyPath(id: string): string {
    return path.join(config.dataDir, "sessions", `${id}.jsonl`);
  }

  createSession(
    userId: string,
    agentId: string,
    title: string,
    projectId: string | null = null,
  ): SessionRecord {
    const id = crypto.randomUUID();
    const cwd = path.join(config.dataDir, "workspaces", userId, id);
    fs.mkdirSync(cwd, { recursive: true });
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      session_id: id,
      user_id: userId,
      agent_id: agentId,
      title,
      cwd,
      engine_session_id: null,
      project_id: projectId,
      created_at: now,
      updated_at: now,
    };
    this.saveSession(rec);
    return rec;
  }

  getSession(id: string): SessionRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.sessionPath(id), "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  saveSession(rec: SessionRecord): void {
    fs.writeFileSync(this.sessionPath(rec.session_id), JSON.stringify(rec, null, 2));
  }

  listSessions(userId: string): SessionMeta[] {
    const dir = path.join(config.dataDir, "sessions");
    if (!fs.existsSync(dir)) return [];
    const out: SessionMeta[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SessionRecord;
        if (rec.user_id === userId) {
          out.push(this.toMeta(rec));
        }
      } catch {
        // skip corrupt records
      }
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return out;
  }

  /** Sessions other users have shared with this user (knowledge sharing). */
  listSharedSessions(excludeUserId: string): SessionMeta[] {
    const dir = path.join(config.dataDir, "sessions");
    if (!fs.existsSync(dir)) return [];
    const out: SessionMeta[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SessionRecord;
        if (rec.shared && rec.user_id !== excludeUserId && sharedWithUser(rec, excludeUserId)) {
          out.push(this.toMeta(rec, rec.user_id));
        }
      } catch {
        // skip corrupt records
      }
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return out;
  }

  private toMeta(rec: SessionRecord, owner?: string): SessionMeta {
    return {
      session_id: rec.session_id,
      title: rec.title,
      agent_id: rec.agent_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      project_id: rec.project_id ?? null,
      shared: rec.shared ?? false,
      shared_with: rec.shared_with ?? [],
      ...(owner ? { owner } : {}),
    };
  }

  deleteSession(id: string): void {
    for (const p of [this.sessionPath(id), this.historyPath(id)]) {
      fs.rmSync(p, { force: true });
    }
  }

  // ---------- projects ----------

  private projectPath(id: string): string {
    return path.join(config.dataDir, "projects", `${id}.json`);
  }

  createProject(
    userId: string,
    name: string,
    agentId: string,
    visibility: "personal" | "public" = "personal",
  ): ProjectRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec: ProjectRecord = {
      project_id: id,
      user_id: userId,
      name,
      agent_id: agentId,
      created_at: now,
      updated_at: now,
      visibility,
    };
    if (visibility === "public") {
      // 公有域项目：工作空间在服务端，客户端永不感知此路径。
      fs.mkdirSync(publicProjectDir(id), { recursive: true });
      fs.writeFileSync(
        path.join(publicProjectDir(id), "README.md"),
        `# ${name}\n\n公有域知识库：所有登录成员可查询；普通成员的修改会转为更新申请，管理员批准后生效。\n`,
      );
    }
    fs.writeFileSync(this.projectPath(id), JSON.stringify(rec, null, 2));
    return rec;
  }

  getProject(id: string): ProjectRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.projectPath(id), "utf8")) as ProjectRecord;
    } catch {
      return null;
    }
  }

  /** 本人全部项目 + 所有公有域项目（公域部分带 owner）。 */
  listProjects(userId: string): ProjectMeta[] {
    const dir = path.join(config.dataDir, "projects");
    if (!fs.existsSync(dir)) return [];
    const out: ProjectMeta[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ProjectRecord;
        if (rec.user_id === userId || rec.visibility === "public") {
          const { user_id, ...meta } = rec;
          out.push({
            ...meta,
            visibility: rec.visibility ?? "personal",
            owner: user_id,
          });
        }
      } catch {
        // skip corrupt records
      }
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  /** Delete a project record and demote its sessions to the default space.
   *  Public projects also lose their server-side workspace. */
  deleteProject(id: string): void {
    const dir = path.join(config.dataDir, "sessions");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(dir, f);
        try {
          const rec = JSON.parse(fs.readFileSync(p, "utf8")) as SessionRecord;
          if (rec.project_id === id) {
            rec.project_id = null;
            fs.writeFileSync(p, JSON.stringify(rec, null, 2));
          }
        } catch {
          // skip corrupt records
        }
      }
    }
    const proj = this.getProject(id);
    if (proj?.visibility === "public") {
      fs.rmSync(publicProjectDir(id), { recursive: true, force: true });
    }
    fs.rmSync(this.projectPath(id), { force: true });
  }

  // ---------- 公有域更新申请（一条申请一个 JSON） ----------

  private updateRequestPath(id: string): string {
    return path.join(config.dataDir, "update-requests", `${id}.json`);
  }

  saveUpdateRequest(rec: UpdateRequestRecord): void {
    fs.writeFileSync(this.updateRequestPath(rec.request_id), JSON.stringify(rec, null, 2));
  }

  getUpdateRequest(id: string): UpdateRequestRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.updateRequestPath(id), "utf8")) as UpdateRequestRecord;
    } catch {
      return null;
    }
  }

  listUpdateRequests(): UpdateRequestRecord[] {
    const dir = path.join(config.dataDir, "update-requests");
    if (!fs.existsSync(dir)) return [];
    const out: UpdateRequestRecord[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as UpdateRequestRecord);
      } catch {
        // skip corrupt records
      }
    }
    // 待审批在前，其余按时间倒序。
    out.sort((a, b) => {
      const pa = a.status === "pending" ? 0 : 1;
      const pb = b.status === "pending" ? 0 : 1;
      return pa !== pb ? pa - pb : b.created_at.localeCompare(a.created_at);
    });
    return out;
  }

  appendBlocks(sessionId: string, blocks: Block[]): void {
    if (blocks.length === 0) return;
    fs.appendFileSync(
      this.historyPath(sessionId),
      blocks.map((b) => JSON.stringify(b)).join("\n") + "\n",
    );
  }

  getHistory(sessionId: string): Block[] {
    try {
      return fs
        .readFileSync(this.historyPath(sessionId), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Block);
    } catch {
      return [];
    }
  }
}
