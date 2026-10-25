import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Block, ServerMessage } from "@blm/protocol";
import { config } from "../config.js";
import type { Store, SessionRecord, ProjectRecord } from "../store.js";
import { isPublicAdmin } from "../users.js";
import { getRole, toPublicRole, type AgentRole } from "./agents.js";
import { TurnQueue } from "./TurnQueue.js";
import { buildSessionOptions, type PublicSessionCtx } from "./sessionOptions.js";
import { createPublicRun } from "./publicTools.js";
import { handleSdkMessage } from "./sdkMessageHandler.js";
import { LLM_AUTH_ERROR_MESSAGE, isAuthFailureText } from "./sdkText.js";
import { ClientRequests } from "./clientRequests.js";
import type { UpdateRequestManager } from "./updateRequests.js";

export interface SessionEvents {
  send(msg: ServerMessage): void;
  /** Whether the session owner (who must approve local actions) is connected. */
  isOwnerOnline?: () => boolean;
}

export class AgentSession {
  readonly record: SessionRecord;
  private role: AgentRole;
  private store: Store;
  private events: SessionEvents;
  private turnQueue = new TurnQueue();
  private q: Query | null = null;
  private abort = new AbortController();
  private disposed = false;
  private busy = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private requests: ClientRequests;

  constructor(
    record: SessionRecord,
    store: Store,
    events: SessionEvents,
    private updateRequests: UpdateRequestManager,
  ) {
    this.record = record;
    this.store = store;
    this.events = events;
    this.role = getRole(record.agent_id);
    this.requests = new ClientRequests(record.session_id, events, () => this.disposed);
  }

  /** Start the engine loop (fresh or resumed). Resolves when the loop starts consuming. */
  start(): void {
    if (this.q) return;
    // 公有属性在每次（重）启动时解析：项目被删除/角色变化自然生效。
    const publicCtx = this.resolvePublicCtx();
    const options = buildSessionOptions(
      this.record,
      this.role,
      this.requests.execSink,
      this.abort,
      (toolName, input) => this.requests.requestPermission(toolName, input),
      publicCtx,
    );
    this.q = query({ prompt: this.turnQueue, options });
    void this.consume();
  }

  /** Session belongs to a public project → use the server-side public executor. */
  private resolvePublicCtx(): PublicSessionCtx | undefined {
    if (!this.record.project_id) return undefined;
    const proj = this.store.getProject(this.record.project_id);
    if (!proj || proj.visibility !== "public") return undefined;
    const run = createPublicRun({
      projectId: proj.project_id,
      projectName: proj.name,
      ownerIsAdmin: isPublicAdmin(this.record.user_id),
      submitWrite: (path, content) => this.submitPublicWrite(proj, path, content),
    });
    return { run, role: toPublicRole(this.role) };
  }

  private async submitPublicWrite(
    proj: ProjectRecord,
    logicalPath: string,
    content: string,
  ): Promise<{ requestId: string }> {
    const { rec } = this.updateRequests.submit({
      project_id: proj.project_id,
      project_name: proj.name,
      session_id: this.record.session_id,
      requester: this.record.user_id,
      path: logicalPath,
      content,
    });
    return { requestId: rec.request_id };
  }

  private async consume(): Promise<void> {
    const q = this.q!;
    try {
      for await (const message of q) {
        if (this.disposed) break;
        handleSdkMessage(message, this.record.session_id, {
          send: (msg) => this.events.send(msg),
          emitBlocks: (blocks) => this.emitBlocks(blocks),
          onEngineSessionId: (engineSessionId) => this.persistEngineSessionId(engineSessionId),
        });
      }
    } catch (err) {
      if (this.disposed || this.abort.signal.aborted) return; // expected on interrupt/dispose
      const raw = err instanceof Error ? err.message : String(err);
      const auth = isAuthFailureText(raw);
      this.events.send({
        type: "error",
        session_id: this.record.session_id,
        code: auth ? "llm_auth" : "agent_error",
        message: auth
          ? LLM_AUTH_ERROR_MESSAGE
          : "智能体处理请求时出现内部错误，请稍后重试。",
      });
      console.error(`[session ${this.record.session_id}] agent loop error:`, raw);
    } finally {
      this.busy = false;
      this.scheduleIdleClose();
    }
  }

  private persistEngineSessionId(engineSessionId: string): void {
    this.record.engine_session_id = engineSessionId;
    this.store.saveSession(this.record);
  }

  private emitBlocks(blocks: Block[]): void {
    if (blocks.length === 0) return;
    this.store.appendBlocks(this.record.session_id, blocks);
    for (const block of blocks) {
      this.events.send({ type: "message_block", session_id: this.record.session_id, block });
    }
  }

  // ---------- public API ----------

  sendUserMessage(text: string): void {
    this.start();
    this.touch();
    this.turnQueue.push(text);
    this.busy = true;
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch {
      // not in streaming mode or already closed
    }
  }

  respondPermission(requestId: string, allow: boolean): void {
    this.requests.respondPermission(requestId, allow);
  }

  respondExec(requestId: string, result: { ok: boolean; output?: string; error?: string }): void {
    this.requests.respondExec(requestId, result);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.requests.failAll();
    this.abort.abort();
    this.turnQueue.end();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  // ---------- idle lifecycle ----------

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleClose(): void {
    this.touch();
    this.idleTimer = setTimeout(() => this.dispose(), config.sessionIdleMs);
    this.idleTimer.unref();
  }
}
