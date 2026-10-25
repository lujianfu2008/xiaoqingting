import type {
  ServerMessage,
  UpdateRequestDetail,
  UpdateRequestStatus,
  UpdateRequestView,
} from "@blm/protocol";
import { Store, type UpdateRequestRecord } from "../store.js";
import { isPublicAdmin, listAdminUsernames } from "../users.js";
import type { ConnectionRegistry } from "./connections.js";
import { resolvePublicPath } from "./publicTools.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 公有域更新申请（审核流）：普通成员对公有工作空间的 write_file 被拦截为
// 一条持久化申请（含待写入全文，批准时"从记录"落盘，服务重启也不丢）。
// 工具调用方非阻塞：提交后立即把"已提交更新申请"回给引擎，决定通过
// REST 到达，再经 WS 通知申请人与管理员。

const PREVIEW_LEN = 500;

export type DecideResult =
  | { ok: true; rec: UpdateRequestRecord }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "not_pending" | "bad_path" | "write_failed";
      message: string;
    };

export interface SubmitUpdateRequestInput {
  project_id: string;
  project_name: string;
  session_id: string;
  requester: string;
  path: string;
  content: string;
}

export function viewOf(rec: UpdateRequestRecord): UpdateRequestView {
  const { content, ...view } = rec;
  return { ...view, preview: content.slice(0, PREVIEW_LEN) };
}

export class UpdateRequestManager {
  constructor(
    private store: Store,
    private conns: ConnectionRegistry,
  ) {}

  /** 提交一条更新申请（同 项目+路径+申请人 已有 pending 时复用既有申请）。 */
  submit(input: SubmitUpdateRequestInput): { rec: UpdateRequestRecord; duplicate: boolean } {
    const existing = this.store
      .listUpdateRequests()
      .find(
        (r) =>
          r.status === "pending" &&
          r.project_id === input.project_id &&
          r.requester === input.requester &&
          r.path === input.path,
      );
    if (existing) return { rec: existing, duplicate: true };

    const rec: UpdateRequestRecord = {
      request_id: crypto.randomUUID(),
      project_id: input.project_id,
      project_name: input.project_name,
      session_id: input.session_id,
      requester: input.requester,
      path: input.path,
      content: input.content,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.store.saveUpdateRequest(rec);
    this.notifyAdmins({ type: "update_request", request: viewOf(rec) });
    return { rec, duplicate: false };
  }

  /** 管理员批准/拒绝。批准时从记录中执行写入（apply-from-record）。 */
  decide(admin: string, requestId: string, approve: boolean, reason?: string): DecideResult {
    const rec = this.store.getUpdateRequest(requestId);
    if (!rec) return { ok: false, code: "not_found", message: "申请不存在。" };
    if (!isPublicAdmin(admin)) return { ok: false, code: "forbidden", message: "没有审批权限。" };
    if (rec.status !== "pending") {
      return { ok: false, code: "not_pending", message: "该申请已被处理。" };
    }

    if (approve) {
      const target = resolvePublicPath(rec.project_id, rec.path);
      if (!target) {
        return { ok: false, code: "bad_path", message: "申请中的路径不合法。" };
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, rec.content, "utf8");
      } catch (err) {
        return {
          ok: false,
          code: "write_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    rec.status = approve ? "approved" : "rejected";
    rec.decided_at = new Date().toISOString();
    rec.decided_by = admin;
    if (reason?.trim()) rec.reason = reason.trim();
    this.store.saveUpdateRequest(rec);

    const msg = { type: "update_request_decided" as const, request: viewOf(rec) };
    this.conns.broadcast(rec.requester, msg);
    this.notifyAdmins(msg);
    return { ok: true, rec };
  }

  /** 列表：管理员看全部，普通用户只看自己的；可按状态过滤。 */
  listFor(userId: string, status?: UpdateRequestStatus): UpdateRequestView[] {
    const admin = isPublicAdmin(userId);
    return this.store
      .listUpdateRequests()
      .filter((r) => (admin || r.requester === userId) && (!status || r.status === status))
      .map(viewOf);
  }

  /** 管理员详情（含待写入全文）。 */
  detail(admin: string, requestId: string): UpdateRequestDetail | null {
    if (!isPublicAdmin(admin)) return null;
    const rec = this.store.getUpdateRequest(requestId);
    if (!rec) return null;
    return { ...viewOf(rec), content: rec.content };
  }

  /** 项目被删除时自动拒绝其全部待审申请并通知申请人。 */
  rejectAllForProject(projectId: string, reason: string): void {
    for (const rec of this.store.listUpdateRequests()) {
      if (rec.project_id !== projectId || rec.status !== "pending") continue;
      rec.status = "rejected";
      rec.decided_at = new Date().toISOString();
      rec.decided_by = "system";
      rec.reason = reason;
      this.store.saveUpdateRequest(rec);
      this.conns.broadcast(rec.requester, {
        type: "update_request_decided",
        request: viewOf(rec),
      });
    }
  }

  private notifyAdmins(msg: ServerMessage): void {
    for (const admin of listAdminUsernames()) {
      this.conns.broadcast(admin, msg);
    }
  }
}
