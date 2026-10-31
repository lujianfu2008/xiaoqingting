import type { Socket } from "node:net";

// In-memory brute-force protection for the public auth endpoints.
// State lives in this process only: a server restart clears it (acceptable —
// this bounds a live attack, not history). NOTE: when deployed behind a
// reverse proxy, request.ip is the proxy unless trustProxy is enabled, so all
// clients would share one register budget; login keys on username|ip, so
// per-account lockout still works there.

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min sliding window
const LOGIN_MAX_FAILS = 5; // fails within the window → lockout
const LOCKOUT_MS = 15 * 60 * 1000; // lockout duration
const REGISTER_MAX_PER_HOUR = 10; // registrations per IP per hour

function clientIpOf(req: { ip?: string; socket?: Socket }): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

interface LoginState {
  fails: number[];
  lockedUntil: number;
}

const loginStates = new Map<string, LoginState>();
const registerHits = new Map<string, number[]>();

export function loginKeyOf(username: string, req: { ip?: string; socket?: Socket }): string {
  return `${username.toLowerCase()}|${clientIpOf(req)}`;
}

/** Whether this username|ip is currently locked out. */
export function checkLogin(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const st = loginStates.get(key);
  if (!st) return { ok: true };
  const remain = st.lockedUntil - Date.now();
  if (remain > 0) return { ok: false, retryAfterSec: Math.ceil(remain / 1000) };
  return { ok: true };
}

export function recordLoginFail(key: string): void {
  const now = Date.now();
  const st = loginStates.get(key) ?? { fails: [], lockedUntil: 0 };
  st.fails = st.fails.filter((t) => now - t < LOGIN_WINDOW_MS);
  st.fails.push(now);
  if (st.fails.length >= LOGIN_MAX_FAILS) {
    st.lockedUntil = now + LOCKOUT_MS;
    st.fails = [];
  }
  loginStates.set(key, st);
}

export function recordLoginSuccess(key: string): void {
  loginStates.delete(key);
}

/** Whether this IP may register right now (sliding hourly window). */
export function checkRegister(req: { ip?: string; socket?: Socket }): { ok: true } | { ok: false; retryAfterSec: number } {
  const ip = clientIpOf(req);
  const now = Date.now();
  const hits = (registerHits.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= REGISTER_MAX_PER_HOUR) {
    const retryAfterSec = Math.ceil((hits[0] + 60 * 60 * 1000 - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

export function recordRegister(req: { ip?: string; socket?: Socket }): void {
  const ip = clientIpOf(req);
  const hits = registerHits.get(ip) ?? [];
  hits.push(Date.now());
  registerHits.set(ip, hits);
}

// Periodic sweep so maps cannot grow without bound.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, st] of loginStates) {
      if (st.lockedUntil < now && (st.fails.length === 0 || now - st.fails[st.fails.length - 1] > LOGIN_WINDOW_MS)) {
        loginStates.delete(key);
      }
    }
    for (const [ip, hits] of registerHits) {
      const live = hits.filter((t) => now - t < 60 * 60 * 1000);
      if (live.length === 0) registerHits.delete(ip);
      else registerHits.set(ip, live);
    }
  },
  10 * 60 * 1000,
).unref();
