import type { FastifyInstance } from "fastify";
import { LoginRequest, LoginResponse, RegisterRequest } from "@blm/protocol";
import { verifyCredentials, addUser, signToken, verifyToken } from "../auth.js";
import { getEmployeeId, employeeIdTaken, isPublicAdmin, isDisabled } from "../users.js";

// Public auth endpoints, plus the JWT hook that protects everything registered
// after this function runs (login/register themselves are exempt).

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post("/auth/login", (req, reply) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { username, password } = parsed.data;
    if (isDisabled(username)) {
      return reply.code(403).send({ error: "account_disabled" });
    }
    if (!verifyCredentials(username, password)) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const body: LoginResponse = {
      token: signToken(username),
      username,
      employee_id: getEmployeeId(username),
      role: isPublicAdmin(username) ? "admin" : "user",
    };
    return reply.send(body);
  });

  app.post("/auth/register", (req, reply) => {
    const parsed = RegisterRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { username, password, employee_id } = parsed.data;
    if (employee_id && employeeIdTaken(employee_id)) {
      return reply.code(409).send({ error: "employee_id_taken" });
    }
    if (!addUser(username, password, employee_id)) {
      return reply.code(409).send({ error: "username_taken" });
    }
    const body: LoginResponse = {
      token: signToken(username),
      username,
      employee_id: getEmployeeId(username),
      role: "user",
    };
    return reply.code(201).send(body);
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/auth/") || req.url.startsWith("/health") || req.url.startsWith("/ws")) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return reply.code(401).send({ error: "unauthorized" });
    // Disabled accounts are locked out of every authenticated call immediately.
    if (isDisabled(payload.uid)) return reply.code(403).send({ error: "account_disabled" });
    req.userId = payload.uid;
  });
}
