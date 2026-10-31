import type { WebSocket } from "ws";
import type { RelayServerMessage, RelayStats } from "@blm/protocol";

// /ws/relay 连接注册表 + 内存统计。
// 单用户单连接（新连踢旧连 4009）：桥消息天然定向，永不经过聊天通道的
// ConnectionRegistry 广播语义。没有隧道表——每条 llm_request 的 pending
// 状态由 llmBridge 自己持有，这里只管「谁的桌面在线」和请求级统计。

interface RelayConn {
  ws: WebSocket;
  since: number;
}

export class RelayRegistry {
  private conns = new Map<string, RelayConn>();
  private requestsTotal = 0;
  private requestsFailed = 0;
  private lastRequest: RelayStats["last_request"];
  private lastError: string | undefined;

  /** 注册 relay 连接。同一用户重复连接时踢掉旧连接（4009 superseded）。 */
  register(username: string, ws: WebSocket): () => void {
    const prev = this.conns.get(username);
    if (prev) {
      try {
        prev.ws.close(4009, "superseded");
      } catch {
        // already closing
      }
    }
    this.conns.set(username, { ws, since: Date.now() });
    return () => {
      const cur = this.conns.get(username);
      if (cur?.ws !== ws) return; // 已被新连接接管，别动别人的状态
      this.conns.delete(username);
    };
  }

  isRelayOnline(username: string): boolean {
    const conn = this.conns.get(username);
    return !!conn && conn.ws.readyState === conn.ws.OPEN;
  }

  onlineUsers(): string[] {
    const out: string[] = [];
    for (const [username, conn] of this.conns) {
      if (conn.ws.readyState === conn.ws.OPEN) out.push(username);
    }
    return out;
  }

  /** 定向发送；false = 连接不在/已死（上层据此回 503）。 */
  sendTo(username: string, msg: RelayServerMessage): boolean {
    const conn = this.conns.get(username);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  // ---------- 统计 ----------

  recordRequest(username: string, host: string): void {
    this.requestsTotal += 1;
    this.lastRequest = { username, host, at: new Date().toISOString(), ok: true };
  }

  recordFailure(username: string, host: string, error: string): void {
    this.requestsFailed += 1;
    this.lastRequest = { username, host, at: new Date().toISOString(), ok: false };
    this.lastError = error;
  }

  recordError(message: string): void {
    this.lastError = message;
  }

  stats(): RelayStats {
    return {
      requests_total: this.requestsTotal,
      requests_failed: this.requestsFailed,
      bridge_online_users: this.onlineUsers(),
      last_request: this.lastRequest,
      last_error: this.lastError,
    };
  }
}

export const relayRegistry = new RelayRegistry();
