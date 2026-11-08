import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

// Multi-user support: file-backed user list (data/users.json).
// userId === username everywhere (JWT uid, session ownership).
// The .env bootstrap account (BLMA_USERNAME/BLMA_PASSWORD) always works too.

interface StoredUser {
  username: string;
  salt: string;
  hash: string; // sha256(salt + password)
  created_at: string;
  // Display-only 工号. Legacy rows (written before v0.4.2) are normalized to
  // their username at load time — no migration script needed.
  employee_id?: string;
  // 公有域管理员角色（缺省 = 普通用户）。bootstrap admin 恒为 admin，与此字段无关。
  role?: "admin" | "reviewer";
  // 禁用账号：登录/REST/WS 全部拒绝。bootstrap admin 不可禁用。
  disabled?: boolean;
  // 注册审核状态：新注册为 pending，审核通过后才能登录。旧账号缺省视为 approved。
  status?: "pending" | "approved" | "rejected";
  // 最近一次改密时间（ISO）：此前签发的 JWT 一律视为过期。
  password_changed_at?: string;
}

export type UserStatus = NonNullable<StoredUser["status"]>;

function usersFile(): string {
  return path.join(config.dataDir, "users.json");
}

function loadUsers(): StoredUser[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(usersFile(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const users = parsed as StoredUser[];
    for (const u of users) if (!u.employee_id) u.employee_id = u.username;
    return users;
  } catch {
    return [];
  }
}

function saveUsers(users: StoredUser[]): void {
  fs.writeFileSync(usersFile(), JSON.stringify(users, null, 2));
}

function hash(salt: string, password: string): string {
  return crypto.createHash("sha256").update(salt + password).digest("hex");
}

export function userExists(username: string): boolean {
  if (username === config.username) return true;
  return loadUsers().some((u) => u.username === username);
}

export function verifyCredentials(identifier: string, password: string): boolean {
  if (identifier === config.username && password === config.password) return true;
  const username = resolveUsername(identifier);
  if (!username) return false;
  const u = loadUsers().find((x) => x.username === username);
  if (!u) return false;
  const a = Buffer.from(hash(u.salt, password));
  const b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Login identifier (用户名或工号) → canonical username. Null if unknown.
 *  用户名与工号是两个互不相交的命名空间（addUser/employeeIdTaken 保证），
 *  任意标识符至多命中一人，无需处理歧义。 */
export function resolveUsername(identifier: string): string | null {
  if (identifier === config.username) return identifier;
  if (config.employeeId && identifier === config.employeeId) return config.username;
  const users = loadUsers();
  const u = users.find((x) => x.username === identifier);
  if (u) return u.username;
  return users.find((x) => (x.employee_id ?? x.username) === identifier)?.username ?? null;
}

/** Whether the string collides with any existing 用户名 or 工号 (bootstrap included). */
export function identifierTaken(identifier: string): boolean {
  return userExists(identifier) || employeeIdTaken(identifier);
}

/** Create a user. Returns false if the username or employee id collides with
 *  any existing username or employee id (the two namespaces must stay disjoint). */
export function addUser(
  username: string,
  password: string,
  employeeId?: string,
  status: UserStatus = "approved",
): boolean {
  if (identifierTaken(username)) return false;
  const emp = (employeeId?.trim() || username).slice(0, 32);
  if (identifierTaken(emp)) return false;
  const users = loadUsers();
  const salt = crypto.randomBytes(16).toString("hex");
  users.push({
    username,
    salt,
    hash: hash(salt, password),
    created_at: new Date().toISOString(),
    employee_id: emp,
    status,
  });
  saveUsers(users);
  return true;
}

/** Whether a 工号 is already used (bootstrap admin included). Also rejects
 *  collisions with any 用户名 — the two namespaces must stay disjoint so that
 *  login can accept either identifier unambiguously. */
export function employeeIdTaken(employeeId: string): boolean {
  const emp = employeeId.trim();
  if (emp === config.employeeId || emp === config.username) return true;
  return loadUsers().some((u) => (u.employee_id ?? u.username) === emp || u.username === emp);
}

/** 工号 for display. Bootstrap admin uses BLMA_EMPLOYEE_ID (default: username). */
export function getEmployeeId(username: string): string {
  if (username === config.username) return config.employeeId || username;
  const u = loadUsers().find((x) => x.username === username);
  return u?.employee_id ?? username;
}

/** All usernames (bootstrap admin included) — used for share-target picking. */
export function listUsernames(): string[] {
  const names = new Set<string>([config.username]);
  for (const u of loadUsers()) names.add(u.username);
  return [...names].sort();
}

/** All users with 工号, for share-target picking (online state filled in by the caller). */
export function listUsers(): { username: string; employee_id: string }[] {
  const out = new Map<string, string>();
  out.set(config.username, config.employeeId || config.username);
  for (const u of loadUsers()) out.set(u.username, u.employee_id ?? u.username);
  return [...out.entries()]
    .map(([username, employee_id]) => ({ username, employee_id }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ---------- 公有域管理员角色 / 账号禁用 ----------

/** Whether the user may manage the public domain (bootstrap admin is always one). */
export function isPublicAdmin(username: string): boolean {
  if (username === config.username) return true;
  return loadUsers().some((u) => u.username === username && u.role === "admin");
}

/** Role for display/clients: admin / reviewer（管理员授权的审核员）/ user. */
export function getRole(username: string): "admin" | "reviewer" | "user" {
  if (username === config.username) return "admin";
  const u = loadUsers().find((x) => x.username === username);
  if (u?.role === "admin" || u?.role === "reviewer") return u.role;
  return "user";
}

/** Whether the user may review registrations (admin, or a granted reviewer). */
export function canReview(username: string): boolean {
  return getRole(username) === "admin" || getRole(username) === "reviewer";
}

/** 所有可审核注册的账号（bootstrap 管理员 + role=admin/reviewer，未禁用）。 */
export function listReviewers(): string[] {
  const names = new Set<string>([config.username]);
  for (const u of loadUsers()) {
    if ((u.role === "admin" || u.role === "reviewer") && u.disabled !== true) {
      names.add(u.username);
    }
  }
  return [...names];
}

/** 当前待审核注册账号数。 */
export function countPendingUsers(): number {
  return loadUsers().filter((u) => (u.status ?? "approved") === "pending").length;
}

/** Whether this is the .env bootstrap account (immutable role/disabled). */
export function isBootstrapAdmin(username: string): boolean {
  return username === config.username;
}

/** Whether the account is disabled (bootstrap admin can never be). */
export function isDisabled(username: string): boolean {
  if (username === config.username) return false;
  return loadUsers().some((u) => u.username === username && u.disabled === true);
}

/** Grant/revoke a role ("user" clears it). Returns false if unknown or bootstrap admin (immutable). */
export function setRole(username: string, role: "admin" | "reviewer" | "user"): boolean {
  if (username === config.username) return false;
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return false;
  if (role === "user") delete u.role;
  else u.role = role;
  saveUsers(users);
  return true;
}

/** Review status (bootstrap admin and legacy rows without the field are approved). */
export function getStatus(username: string): UserStatus {
  if (username === config.username) return "approved";
  return loadUsers().find((u) => u.username === username)?.status ?? "approved";
}

/** Set the review status. Returns false if unknown or bootstrap admin (immutable). */
export function setStatus(username: string, status: UserStatus): boolean {
  if (username === config.username) return false;
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return false;
  u.status = status;
  saveUsers(users);
  return true;
}

export type ChangePasswordResult = "ok" | "not_found" | "bootstrap" | "bad_credentials";

/** Self-service password change (file-backed users only; the bootstrap
 *  password lives in .env and cannot change here). Rotates the salt and
 *  stamps password_changed_at so tokens issued before now become stale. */
export function changePassword(
  username: string,
  oldPassword: string,
  newPassword: string,
): ChangePasswordResult {
  if (username === config.username) return "bootstrap";
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return "not_found";
  const a = Buffer.from(hash(u.salt, oldPassword));
  const b = Buffer.from(u.hash);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return "bad_credentials";
  u.salt = crypto.randomBytes(16).toString("hex");
  u.hash = hash(u.salt, newPassword);
  u.password_changed_at = new Date().toISOString();
  saveUsers(users);
  return "ok";
}

/** Admin reset: set a new password without the old one. False if unknown or bootstrap. */
export function resetPassword(username: string, newPassword: string): boolean {
  if (username === config.username) return false;
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return false;
  u.salt = crypto.randomBytes(16).toString("hex");
  u.hash = hash(u.salt, newPassword);
  u.password_changed_at = new Date().toISOString();
  saveUsers(users);
  return true;
}

/** Epoch seconds of the last password change (null = never / bootstrap). */
export function getPasswordChangedAt(username: string): number | null {
  if (username === config.username) return null;
  const iso = loadUsers().find((u) => u.username === username)?.password_changed_at;
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : null;
}

/** Enable/disable an account. Returns false if unknown or bootstrap admin (immutable). */
export function setDisabled(username: string, disabled: boolean): boolean {
  if (username === config.username) return false;
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return false;
  if (disabled) u.disabled = true;
  else delete u.disabled;
  saveUsers(users);
  return true;
}

/** Role/status/disabled/created_at for one user (bootstrap admin included), or null if unknown. */
export function getUserRecord(username: string): {
  created_at?: string;
  role: "admin" | "reviewer" | "user";
  disabled: boolean;
  status: UserStatus;
} | null {
  if (username === config.username) {
    return { role: "admin", disabled: false, status: "approved" };
  }
  const u = loadUsers().find((x) => x.username === username);
  if (!u) return null;
  return {
    created_at: u.created_at,
    role: getRole(username),
    disabled: u.disabled === true,
    status: u.status ?? "approved",
  };
}

/** All public-admin usernames (bootstrap admin included). */
export function listAdminUsernames(): string[] {
  const names = new Set<string>([config.username]);
  for (const u of loadUsers()) if (u.role === "admin") names.add(u.username);
  return [...names];
}

