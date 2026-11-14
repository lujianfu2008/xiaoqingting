import type { SessionSearchItem, SessionSearchMatch } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";

// 会话内容全文搜索（GET /api/sessions/search）：遍历本人会话的块
// 历史，只匹配 user_text/text 块文本（工具调用/结果/结构块跳过）。
// 归属安全：会话清单来自 manager.listSessions（按 user_id 过滤），
// 历史读取经 manager.getHistory（带所有权校验），扫不到他人会话。

const SNIPPET_CTX = 60; // 命中词前后各取的字符数
const MAX_MATCHES = 3; // 每会话返回的命中条数上限（total 不截断）
const CACHE_TTL_MS = 60_000; // 结果内存缓存 60s（防连点/连续输入重扫）
const CACHE_MAX = 100;

// 键 = userId + \0 + 小写 q：同用户不同词互不串缓存。
const cache = new Map<string, { ts: number; data: SessionSearchItem[] }>();

function cacheGet(key: string): SessionSearchItem[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cachePut(key: string, data: SessionSearchItem[]): void {
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) {
      if (Date.now() - v.ts > CACHE_TTL_MS) cache.delete(k);
    }
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, { ts: Date.now(), data });
}

/** 单行摘要：命中词前后各 ~60 字，命中词以 ** 包裹（客户端高亮）。 */
function makeSnippet(text: string, hitStart: number, hitLen: number): string {
  const start = Math.max(0, hitStart - SNIPPET_CTX);
  const end = Math.min(text.length, hitStart + hitLen + SNIPPET_CTX);
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
  return (
    (start > 0 ? "…" : "") +
    flat(text.slice(start, hitStart)) +
    `**${text.slice(hitStart, hitStart + hitLen)}**` +
    flat(text.slice(hitStart + hitLen, end)) +
    (end < text.length ? "…" : "")
  );
}

/** 跨会话搜索本人块历史；结果按会话更新时间倒序（listSessions 已排）。 */
export function searchUserSessions(
  manager: AgentManager,
  userId: string,
  q: string,
  limit: number,
): SessionSearchItem[] {
  const needle = q.toLowerCase();
  const key = `${userId}\u0000${needle}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const out: SessionSearchItem[] = [];
  for (const meta of manager.listSessions(userId)) {
    const history = manager.getHistory(userId, meta.session_id);
    if (!history) continue;
    const matches: SessionSearchMatch[] = [];
    let total = 0;
    for (let i = 0; i < history.blocks.length; i++) {
      const b = history.blocks[i];
      if (b.kind !== "user_text" && b.kind !== "text") continue;
      const pos = b.text.toLowerCase().indexOf(needle);
      if (pos === -1) continue;
      total++;
      if (matches.length < MAX_MATCHES) {
        matches.push({
          block_index: i,
          snippet: makeSnippet(b.text, pos, needle.length),
          // 块历史不落时间戳，以会话最近更新时间作参考。
          created_at: meta.updated_at,
        });
      }
    }
    if (total > 0) {
      out.push({
        session_id: meta.session_id,
        session_title: meta.title,
        project_id: meta.project_id ?? null,
        matches,
        total,
      });
    }
  }
  const page = out.slice(0, limit);
  cachePut(key, page);
  return page;
}
