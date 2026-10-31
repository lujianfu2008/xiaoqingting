import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Block, ServerMessage, Usage } from "@blm/protocol";
import { config } from "../config.js";
import type { Store, SessionRecord, ProjectRecord } from "../store.js";
import { isPublicAdmin } from "../users.js";
import { getRole, toPublicRole, type AgentRole } from "./agents.js";
import { TurnQueue } from "./TurnQueue.js";
import { buildSessionOptions, type PublicSessionCtx } from "./sessionOptions.js";
import { createPublicRun } from "./publicTools.js";
import { handleSdkMessage } from "./sdkMessageHandler.js";
import { LLM_AUTH_ERROR_MESSAGE, isAuthFailureText, isBudgetExhaustedText } from "./sdkText.js";
import { ClientRequests } from "./clientRequests.js";
import type { UpdateRequestManager } from "./updateRequests.js";

export interface SessionEvents {
  send(msg: ServerMessage): void;
  /** Whether the session owner (who must approve local actions) is connected. */
  isOwnerOnline?: () => boolean;
  /** Called once on dispose（空闲回收/引擎循环退出）so the holder can drop it
   *  from its session map — a dead session left in the map would silently
   *  swallow every later message pushed into its queue. */
  onDispose?: () => void;
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
  private watchdog: NodeJS.Timeout | null = null;
  private turnActive = false;
  private onDispose?: () => void;
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
    this.onDispose = events.onDispose;
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
          onUsage: (usage) => this.recordUsage(usage),
          onTurnEnd: () => {
            // 回合结束：队列里还有背靠背排队的消息时引擎马上继续跑，保持 busy；
            // 否则标记空闲——disposeIdleSessions（更换 LLM/MCP 配置后调用）
            // 才能回收热会话，让下一条消息按新配置 resume 重建。（此前 busy
            // 在引擎循环存活期间一直为 true，配置变更永远跳过热会话。）
            this.busy = this.turnQueue.pending > 0;
            this.turnActive = false;
            this.disarmWatchdog();
            this.scheduleIdleClose();
          },
        });
        // 回合有动静（任何 SDK 消息）就续期看门狗；回合结束则解除。
        if (this.turnActive) this.armWatchdog();
      }
    } catch (err) {
      if (this.disposed || this.abort.signal.aborted) return; // expected on interrupt/dispose
      const raw = err instanceof Error ? err.message : String(err);
      const auth = isAuthFailureText(raw);
      const budget = isBudgetExhaustedText(raw);
      this.events.send({
        type: "error",
        session_id: this.record.session_id,
        code: auth ? "llm_auth" : budget ? "llm_budget" : "agent_error",
        message: auth
          ? LLM_AUTH_ERROR_MESSAGE
          : budget
            ? `本次会话累计费用已达上限（$${config.maxBudgetUsd}），引擎已停止调用模型。请新开会话继续，或由服务端调大 MAX_BUDGET_USD。`
            : "智能体处理请求时出现内部错误，请稍后重试。",
      });
      console.error(`[session ${this.record.session_id}] agent loop error:`, raw);
    } finally {
      this.busy = false;
      // 引擎循环已退出（空闲回收/出错/子进程结束）：立即自毁并经 onDispose
      // 从持有方的 Map 摘除。否则会话变僵尸，后续消息推进死队列被静默吞掉；
      // 摘除后下一条消息按 engine_session_id resume 重建，上下文不丢。
      this.dispose();
    }
  }

  private persistEngineSessionId(engineSessionId: string): void {
    this.record.engine_session_id = engineSessionId;
    this.store.saveSession(this.record);
  }

  /** 累计本会话 token 用量（每条回复一次，随 record 落库并出现在会话 meta）。 */
  private recordUsage(usage: Usage): void {
    const prev = this.record.usage;
    this.record.usage = {
      input_tokens: (prev?.input_tokens ?? 0) + usage.input_tokens,
      output_tokens: (prev?.output_tokens ?? 0) + usage.output_tokens,
      cost_usd:
        prev?.cost_usd != null || usage.cost_usd != null
          ? (prev?.cost_usd ?? 0) + (usage.cost_usd ?? 0)
          : null,
    };
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
    if (this.disposed) return; // 已回收：持有方经 onDispose 摘除后会新建，不应走到这里
    this.start();
    this.touch();
    this.turnQueue.push(text);
    this.busy = true;
    // 排队的后续消息不重置看门狗死线：死线只随引擎消息续期。引擎卡死时
    // 用户的催促不该把死线越推越远（实测连发消息能无限顺延触达时间）。
    if (!this.turnActive) {
      this.turnActive = true;
      this.armWatchdog();
    }
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
    this.disarmWatchdog();
    this.requests.failAll();
    this.abort.abort();
    this.turnQueue.end();
    // 通知持有方把自己从会话表摘掉，防止僵尸会话吞掉后续消息。
    this.onDispose?.();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  // ---------- idle lifecycle ----------

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Turn finished: reap the engine after SESSION_IDLE_MS of silence
   *  (cancelled by the next sendUserMessage via touch()). */
  private scheduleIdleClose(): void {
    this.touch();
    this.idleTimer = setTimeout(() => this.dispose(), config.sessionIdleMs);
    this.idleTimer.unref();
  }

  // ---------- turn watchdog ----------
  // 引擎回合可能永久静默卡死：模型 API 流式响应中途停摆（SDK 对流中停摆
  // 无超时）、子进程失联等。此时 result/error 永远不来，客户端 busy 卡死，
  // 输入被无声吞掉。看门狗以「回合内连续无 SDK 消息」判死：先告知客户端
  // （复位 busy），再强杀引擎——会话经 onDispose 摘除，下一条消息按
  // engine_session_id resume 重建。

  private armWatchdog(): void {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.disposed) return;
      console.warn(`[session ${this.record.session_id}] turn stalled ${config.turnWatchdogMs}ms without engine messages — aborting`);
      this.events.send({
        type: "error",
        session_id: this.record.session_id,
        code: "agent_timeout",
        message: "模型长时间没有响应，本次回复已中止。请重新发送消息再试。",
      });
      this.abort.abort();
      // abort 未必能让卡死的引擎迭代器退出（预算耗尽等场景 CLI 会静默僵死、
      // 连错误结果都不发）。10s 后仍未自毁就强制 dispose：从持有方 Map 摘除，
      // 后续消息走 resume 重建——绝不允许会话永久吞消息。僵死的 CLI 子进程
      // 可能残留（idle 不耗 CPU），随服务进程退出回收。
      setTimeout(() => {
        if (!this.disposed) {
          console.warn(`[session ${this.record.session_id}] engine still wedged after abort — forcing dispose`);
          this.dispose();
        }
      }, 10_000).unref();
    }, config.turnWatchdogMs);
    this.watchdog.unref();
  }

  private disarmWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
