import process from "node:process";
import { loadSettings, patchSettings, type ActiveLogin } from "./settings";

// Local single-login lock: two app instances on this machine must not be
// logged into the same account at once. Each logged-in instance registers an
// ActiveLogin entry (keyed by its pid) in the shared settings.json and
// heartbeats it; a login/auto-login is refused while a live entry for that
// account exists. Crashed instances unlock themselves: their pid is gone.
// Matching is on employee_id OR username — the login form only has a username
// field, the register form only an employee-id field, and both are 1:1.

const HEARTBEAT_MS = 15_000;
const STALE_MS = 45_000;

let heartbeat: NodeJS.Timeout | null = null;
// This instance's registered login; the source of truth for heartbeating so a
// racing settings.json write can never permanently drop our entry.
let mine: { employee_id: string; username: string } | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Drop dead/stale entries from the file (own entry is alive and fresh).
 *  Returns the live entries of OTHER instances. */
export function activeLogins(): ActiveLogin[] {
  const now = Date.now();
  const all = loadSettings().activeLogins;
  const live = all.filter((l) => pidAlive(l.pid) && now - l.updated_at < STALE_MS);
  if (live.length !== all.length) patchSettings({ activeLogins: live });
  return live.filter((l) => l.pid !== process.pid);
}

/** True when `userOrEid` (username or employee id) is signed in elsewhere here. */
export function isAccountLocked(userOrEid: string): boolean {
  const key = userOrEid.trim();
  if (!key) return false;
  return activeLogins().some((l) => l.employee_id === key || l.username === key);
}

/** Register this instance's login (replaces any previous entry of ours). */
export function acquireLogin(employeeId: string, username: string): void {
  mine = { employee_id: employeeId, username };
  patchSettings({
    activeLogins: [
      ...activeLogins(),
      { employee_id: employeeId, username, pid: process.pid, updated_at: Date.now() },
    ],
  });
  if (!heartbeat) {
    heartbeat = setInterval(refreshLogin, HEARTBEAT_MS);
    heartbeat.unref?.();
  }
}

function refreshLogin(): void {
  if (!mine) return; // released (logout/quit) — never resurrect
  patchSettings({
    activeLogins: [
      ...activeLogins(),
      { ...mine, pid: process.pid, updated_at: Date.now() },
    ],
  });
}

/** Drop this instance's entry (logout / quit). Safe to call repeatedly. */
export function releaseLogin(): void {
  mine = null;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  const all = loadSettings().activeLogins;
  if (all.some((l) => l.pid === process.pid)) {
    patchSettings({ activeLogins: all.filter((l) => l.pid !== process.pid) });
  }
}
