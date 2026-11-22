// 共享会话附件引用（att:<sessionId>/<attachmentId>）：消息里的 [附件] 行
// 在共享会话/协作线程里不再携带发送方本机路径（跨机必然不可达），改带
// 服务端托管引用。谁要字节谁拉取：查看器点击与引擎 read_attachment 都走
// downloadAttachment 落到本机附件目录（豁免围栏）再走既有读取链路。
// 纯函数 + 纯 fetch，方便无壳单测。

export const ATT_REF_PREFIX = "att:";

/** 是否服务端托管引用（att:<sessionId>/<id>）。 */
export function isAttRef(p: string): boolean {
  return p.startsWith(ATT_REF_PREFIX);
}

export interface AttRef {
  sessionId: string;
  id: string;
}

/** 解析引用；格式不对返回 null（调用方按普通路径兜底）。 */
export function parseAttRef(p: string): AttRef | null {
  if (!isAttRef(p)) return null;
  const rest = p.slice(ATT_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const sessionId = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return { sessionId, id };
}

export function buildAttRef(sessionId: string, id: string): string {
  return `${ATT_REF_PREFIX}${sessionId}/${id}`;
}

/** base64 → Uint8Array（分块避免 apply 栈溢出）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  const CHUNK = 0x8000;
  for (let i = 0; i < bin.length; i += CHUNK) {
    out.set(Uint8Array.from(bin.slice(i, i + CHUNK).split("").map((c) => c.charCodeAt(0))), i);
  }
  return out;
}

/** 上传：读到的 base64 直接 POST 给服务端，返回引用。失败抛错（调用方
 *  决定降级策略——保持本地路径 + 如实提示）。 */
export async function uploadAttachment(
  serverUrl: string,
  token: string,
  sessionId: string,
  name: string,
  base64: string,
): Promise<string> {
  const res = await fetch(`${apiBaseOf(serverUrl)}/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, data: base64 }),
  });
  if (!res.ok) throw new Error(`attachment_upload_${res.status}`);
  const body = (await res.json()) as { ok?: boolean; id?: string; name?: string };
  if (!body.ok || !body.id) throw new Error("attachment_upload_bad_response");
  return buildAttRef(sessionId, body.id);
}

/** 下载：拉原始字节（查看器取流与引擎 read_attachment 取回共用）。 */
export async function downloadAttachment(
  serverUrl: string,
  token: string,
  ref: AttRef,
): Promise<{ bytes: Uint8Array; name: string }> {
  const res = await fetch(
    `${apiBaseOf(serverUrl)}/api/sessions/${encodeURIComponent(ref.sessionId)}/attachments/${encodeURIComponent(ref.id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`attachment_download_${res.status}`);
  const dispo = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="?([^";]+)"?/.exec(dispo);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, name: m?.[1] ?? "attachment" };
}

function apiBaseOf(serverUrl: string): string {
  // 与 store/http.ts 的 apiBase 同构：只剥尾部斜杠、不追加路径段。
  // REST 调用点在 URL 前各自补 /api（eg. `${apiBaseOf(u)}/api/sessions/...`）。
  // 之前误加了 "/api"，导致打进 /api/api/sessions/...（404，附件上传永远失败）。
  return `${serverUrl.replace(/\/+$/, "")}`;
}
