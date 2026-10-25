import type { AttachmentImage, ServerMessage } from "@blm/protocol";
import { config } from "../config.js";
import { sanitizeToolName } from "./mcp.js";
import type { ExecSink } from "./clientTools/index.js";
import { PendingMap } from "./pending.js";

// Requests that need an answer from the user's client: tool approvals and
// local-execution calls. Each waits for the matching WS response (or times out).

type ExecResult = {
  ok: boolean;
  output?: string;
  error?: string;
  images?: AttachmentImage[];
};
interface PermissionVerdict {
  allow: boolean;
  timedOut: boolean;
}

export interface ClientRequestEvents {
  send(msg: ServerMessage): void;
  /** Whether the session owner (who must approve local actions) is connected. */
  isOwnerOnline?: () => boolean;
}

export class ClientRequests {
  private sessionId: string;
  private events: ClientRequestEvents;
  private isDisposed: () => boolean;
  private pendingPermissions: PendingMap<PermissionVerdict>;
  private pendingExecs: PendingMap<ExecResult>;

  /** ExecSink: proxies a tool call to the user's client over WebSocket. */
  readonly execSink: ExecSink;

  constructor(
    sessionId: string,
    events: ClientRequestEvents,
    isDisposed: () => boolean,
  ) {
    this.sessionId = sessionId;
    this.events = events;
    this.isDisposed = isDisposed;
    this.pendingPermissions = new PendingMap<PermissionVerdict>(`${sessionId}:`);
    this.pendingExecs = new PendingMap<ExecResult>(`${sessionId}:exec`);
    this.execSink = {
      requestClientExec: (sid, action, params, timeoutMs) =>
        this.requestClientExec(sid, action, params, timeoutMs),
    };
  }

  // ---------- permissions ----------

  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const requestId = this.pendingPermissions.nextId();
    this.events.send({
      type: "permission_request",
      request_id: requestId,
      session_id: this.sessionId,
      tool_name: sanitizeToolName(toolName),
      input,
    });
    return this.pendingPermissions
      .request(requestId, config.permissionTimeoutMs, { allow: false, timedOut: true })
      .then((v) =>
        v.allow
          ? { behavior: "allow" as const }
          : {
              behavior: "deny" as const,
              message: v.timedOut ? "审批超时，已自动拒绝。" : "用户拒绝了此操作。",
            },
      );
  }

  respondPermission(requestId: string, allow: boolean): void {
    this.pendingPermissions.settle(requestId, { allow, timedOut: false });
  }

  // ---------- client-side tool execution ----------

  private requestClientExec(
    sessionId: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ExecResult> {
    if (this.isDisposed()) {
      return Promise.resolve({ ok: false, error: "会话已关闭。" });
    }
    // Local actions can only be performed by the session owner's client. If they
    // are offline, fail now instead of waiting for the full client timeout.
    if (this.events.isOwnerOnline && !this.events.isOwnerOnline()) {
      return Promise.resolve({
        ok: false,
        error: "会话主人不在线，无法执行本机操作。请在主人上线后重试。",
      });
    }
    const requestId = this.pendingExecs.nextId();
    this.events.send({
      type: "tool_exec_request",
      request_id: requestId,
      session_id: sessionId,
      action: action as "run_command",
      params,
    });
    return this.pendingExecs.request(requestId, timeoutMs, {
      ok: false,
      error: "客户端响应超时，请确认客户端在线后重试。",
    });
  }

  respondExec(requestId: string, result: ExecResult): void {
    this.pendingExecs.settle(requestId, result);
  }

  /** Resolve everything still pending because the session is closing. */
  failAll(): void {
    this.pendingPermissions.failAll({ allow: false, timedOut: false });
    this.pendingExecs.failAll({ ok: false, error: "会话已关闭。" });
  }
}
