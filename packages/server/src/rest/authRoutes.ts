import type { FastifyInstance } from "fastify";
import {
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  WsReviewRequest,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { verifyCredentials, addUser, signToken, verifyToken } from "../auth.js";
import {
  checkLogin,
  recordLoginFail,
  recordLoginSuccess,
  checkRegister,
  recordRegister,
  loginKeyOf,
} from "../rateLimit.js";
import {
  getEmployeeId,
  employeeIdTaken,
  getRole,
  isDisabled,
  getStatus,
  getPasswordChangedAt,
  listReviewers,
  countPendingUsers,
} from "../users.js";

// Public auth endpoints, plus the JWT hook that protects everything registered
// after this function runs (login/register themselves are exempt).

export function registerAuthRoutes(app: FastifyInstance, manager: AgentManager): void {
  app.post("/auth/login", (req, reply) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { username, password } = parsed.data;
    // 防爆破：用户名+IP 维度失败锁定（只在密码错误时计次，待审核等状态不锁定）。
    const key = loginKeyOf(username, req);
    const gate = checkLogin(key);
    if (!gate.ok) {
      reply.header("retry-after", gate.retryAfterSec);
      return reply.code(429).send({ error: "too_many_attempts", retry_after: gate.retryAfterSec });
    }
    if (isDisabled(username)) {
      return reply.code(403).send({ error: "account_disabled" });
    }
    if (!verifyCredentials(username, password)) {
      recordLoginFail(key);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    // 注册审核：待审核/已拒绝的账号不能登录（放在凭据校验之后，避免向猜密码者泄露账号状态）。
    const status = getStatus(username);
    if (status === "pending") return reply.code(403).send({ error: "pending_review" });
    if (status === "rejected") return reply.code(403).send({ error: "review_rejected" });
    recordLoginSuccess(key);
    const body: LoginResponse = {
      token: signToken(username),
      username,
      employee_id: getEmployeeId(username),
      role: getRole(username),
    };
    return reply.send(body);
  });

  app.post("/auth/register", (req, reply) => {
    const parsed = RegisterRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    // 防：单 IP 批量刷待审核账号。
    const reg = checkRegister(req);
    if (!reg.ok) {
      reply.header("retry-after", reg.retryAfterSec);
      return reply.code(429).send({ error: "rate_limited", retry_after: reg.retryAfterSec });
    }
    const { username, password, employee_id } = parsed.data;
    if (employee_id && employeeIdTaken(employee_id)) {
      return reply.code(409).send({ error: "employee_id_taken" });
    }
    // 新注册账号进入待审核：不发 token，需管理员/审核员通过后才能登录。
    if (!addUser(username, password, employee_id, "pending")) {
      return reply.code(409).send({ error: "username_taken" });
    }
    recordRegister(req);
    const body: RegisterResponse = {
      username,
      employee_id: getEmployeeId(username),
      status: "pending",
    };
    // 实时提醒在线的审核员/管理员（离线者靠下次上线的补推）。
    const notice: WsReviewRequest = { type: "review_request", pending: countPendingUsers() };
    for (const reviewer of listReviewers()) {
      manager.sendToUser(reviewer, notice);
    }
    return reply.code(201).send(body);
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/auth/") || req.url.startsWith("/health") || req.url.startsWith("/ws")) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return reply.code(401).send({ error: "unauthorized" });
    // Disabled or unreviewed accounts are locked out of every authenticated call.
    if (isDisabled(payload.uid)) return reply.code(403).send({ error: "account_disabled" });
    const status = getStatus(payload.uid);
    if (status !== "approved") {
      return reply.code(403).send({
        error: status === "pending" ? "pending_review" : "review_rejected",
      });
    }
    // 改密前签发的 token 一律视为过期（改密会使所有旧会话立即失效）。
    const pwc = getPasswordChangedAt(payload.uid);
    if (pwc !== null && payload.iat !== undefined && payload.iat < pwc) {
      return reply.code(401).send({ error: "token_stale" });
    }
    req.userId = payload.uid;
  });
}
