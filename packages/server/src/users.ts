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
  role?: "admin";
  // 禁用账号：登录/REST/WS 全部拒绝。bootstrap admin 不可禁用。
  disabled?: boolean;
}

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

export function verifyCredentials(username: string, password: string): boolean {
  if (username === config.username && password === config.password) return true;
  const u = loadUsers().find((x) => x.username === username);
  if (!u) return false;
  const a = Buffer.from(hash(u.salt, password));
  const b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Create a user. Returns false if the username or employee id is taken. */
export function addUser(
  username: string,
  password: string,
  employeeId?: string,
): boolean {
  if (userExists(username)) return false;
  const emp = (employeeId?.trim() || username).slice(0, 32);
  if (employeeIdTaken(emp)) return false;
  const users = loadUsers();
  const salt = crypto.randomBytes(16).toString("hex");
  users.push({
    username,
    salt,
    hash: hash(salt, password),
    created_at: new Date().toISOString(),
    employee_id: emp,
  });
  saveUsers(users);
  return true;
}

/** Whether a 工号 is already used (bootstrap admin included). */
export function employeeIdTaken(employeeId: string): boolean {
  const emp = employeeId.trim();
  if (emp === config.employeeId || emp === config.username) return true;
  return loadUsers().some((u) => (u.employee_id ?? u.username) === emp);
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

/** Whether this is the .env bootstrap account (immutable role/disabled). */
export function isBootstrapAdmin(username: string): boolean {
  return username === config.username;
}

/** Whether the account is disabled (bootstrap admin can never be). */
export function isDisabled(username: string): boolean {
  if (username === config.username) return false;
  return loadUsers().some((u) => u.username === username && u.disabled === true);
}

/** Grant/revoke the public-admin role. Returns false if unknown or bootstrap admin (immutable). */
export function setRole(username: string, role: "admin" | "user"): boolean {
  if (username === config.username) return false;
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return false;
  if (role === "admin") u.role = "admin";
  else delete u.role;
  saveUsers(users);
  return true;
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

/** Role/disabled/created_at for one user (bootstrap admin included), or null if unknown. */
export function getUserRecord(username: string): { created_at?: string; role: "admin" | "user"; disabled: boolean } | null {
  if (username === config.username) {
    return { role: "admin", disabled: false };
  }
  const u = loadUsers().find((x) => x.username === username);
  if (!u) return null;
  return { created_at: u.created_at, role: u.role === "admin" ? "admin" : "user", disabled: u.disabled === true };
}

/** All public-admin usernames (bootstrap admin included). */
export function listAdminUsernames(): string[] {
  const names = new Set<string>([config.username]);
  for (const u of loadUsers()) if (u.role === "admin") names.add(u.username);
  return [...names];
}

