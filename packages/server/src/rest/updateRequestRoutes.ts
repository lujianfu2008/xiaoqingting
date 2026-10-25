import type { FastifyInstance } from "fastify";
import {
  DecideUpdateRequest,
  UpdateRequestStatus,
  UpdateRequestsResponse,
  UpdateRequestView,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { isPublicAdmin } from "../users.js";
import { viewOf } from "../agent/updateRequests.js";

// 公有域更新申请（审核流）：列表/详情/决定。注册在 JWT 钩子之后。

export function registerUpdateRequestRoutes(app: FastifyInstance, manager: AgentManager): void {
  // 列表：管理员看全部，普通用户只看自己的；可选 ?status=pending 过滤。
  app.get("/api/update-requests", (req, reply) => {
    const q = (req.query ?? {}) as { status?: string };
    let status: UpdateRequestStatus | undefined;
    if (q.status) {
      const parsed = UpdateRequestStatus.safeParse(q.status);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      status = parsed.data;
    }
    const body: UpdateRequestsResponse = {
      requests: manager.listUpdateRequests(req.userId, status),
    };
    return body;
  });

  // 详情（含待写入全文）——仅管理员。
  app.get("/api/update-requests/:id", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const detail = manager.getUpdateRequestDetail(req.userId, (req.params as { id: string }).id);
    if (!detail) return reply.code(404).send({ error: "not_found" });
    return detail;
  });

  // 批准/拒绝——仅管理员；批准即刻从记录落盘。
  app.post("/api/update-requests/:id/decide", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = DecideUpdateRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = manager.decideUpdateRequest(
      req.userId,
      (req.params as { id: string }).id,
      parsed.data.approve,
      parsed.data.reason,
    );
    if (!result.ok) {
      const codes = {
        not_found: 404,
        forbidden: 403,
        not_pending: 409,
        bad_path: 400,
        write_failed: 500,
      } as const;
      return reply
        .code(codes[result.code])
        .send({ error: result.code, message: result.message });
    }
    const body: UpdateRequestView = viewOf(result.rec);
    return body;
  });
}
