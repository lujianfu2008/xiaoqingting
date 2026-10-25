export function apiBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export function wsBase(url: string): string {
  const u = new URL(apiBase(url));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/+$/, "");
}
