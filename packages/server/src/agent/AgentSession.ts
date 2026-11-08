import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Block, ServerMessage, Usage } from "@blm/protocol";
import { config } from "../config.js";
import type { Store, SessionRecord, ProjectRecord } from "../store.js";
import { isPublicAdmin } from "../users.js";
import { getRole, toPublicRole, type AgentRole } from "./agents.js";
import { TurnQueue } from "./TurnQueue.js";
import { buildSessionOptions, type DelegationGate, type PublicSessionCtx } from "./sessionOptions.js";
import { createPublicRun } from "./publicTools.js";
import { handleSdkMessage } from "./sdkMessageHandler.js";
import { LLM_AUTH_ERROR_MESSAGE, isAuthFailureText, isBudgetExhaustedText } from "./sdkText.js";
import { ClientRequests } from "./clientRequests.js";
import type { UpdateRequestManager } from "./updateRequests.js";

export interface SessionEvents {
  send(msg: ServerMessage): void;
  /** 当前负责人（本机操作的执行者，工作台跟随指派）是否在线。 */
  isExecutorOnline?: () => boolean;
  /** Called once on dispose（空闲回收/引擎循环退出）so the holder can drop it
   *  from its session map — a dead session left in the map would silently
   *  swallow every later message pushed into its queue. */
  onDispose?: () => void;
}

// ---------- 子代理委派闸门 ----------
// 在飞记账两条释放路径：task_notification（正路；确认后台后 tool_result 不再
// 释放）与委派 tool_result（兜底，兼容无 task 事件的老 CLI）。次数上限按回合
// 清零；并发占用跨回合保留（后台子代理活得比回合久）。若某后台委派的
// task_notification 因引擎异常缺失，占用会泄漏到会话 dispose——代价只是并发
// 上限少一格，可接受。

class DelegationGateImpl implements DelegationGate {
  private flight = new Map<string, { key: string; taskId?: string; backgrounded?: boolean }>();
  private byTask = new Map<string, string>(); // task_id → toolUseId
  private turnCount = 0;

  get inFlight(): number {
    return this.flight.size;
  }

  tryStart(
    input: Record<string, unknown>,
    allowedKeys: string[],
    toolUseId: string,
  ): "ok" | "cap" | "unknown_type" | "remote" {
    const key = typeof input.subagent_type === "string" ? input.subagent_type : "";
    if (!key || !allowedKeys.includes(key)) return "unknown_type";
    if ((input as { isolation?: unknown }).isolation === "remote") return "remote";
    if (this.turnCount >= config.maxDelegationsPerTurn) return "cap";
    if (this.flight.size >= config.maxConcurrentSubagents) return "cap";
    this.turnCount++;
    this.flight.set(toolUseId, { key });
    return "ok";
  }

  keyForTask(taskId: string): string | undefined {
    const tid = this.byTask.get(taskId);
    return tid ? this.flight.get(tid)?.key : undefined;
  }

  markTaskStarted(
    taskId: string,
    toolUseId: string | undefined,
    key: string | undefined,
  ): void {
    if (!toolUseId) return;
    const e = this.flight.get(toolUseId);
    if (!e) return; // 未知委派（resume 前的旧账等）——不追踪
    e.taskId = taskId;
    e.backgrounded = true;
    if (key && !e.key) e.key = key;
    this.byTask.set(taskId, toolUseId);
  }

  releaseTask(taskId: string): void {
    const tid = this.byTask.get(taskId);
    if (!tid) return;
    this.byTask.delete(taskId);
    this.flight.delete(tid);
  }

  releaseToolUse(toolUseId: string): void {
    const e = this.flight.get(toolUseId);
    if (!e || e.backgrounded) return;
    if (e.taskId) this.byTask.delete(e.taskId);
    this.flight.delete(toolUseId);
  }

  resetTurn(): void {
    this.turnCount = 0;
  }

  /** 安全网：canUseTool 放行过的委派理论上已在账，这里兜重复登记/漏账。 */
  ensure(toolUseId: string, key: string): void {
    if (!key || this.flight.has(toolUseId)) return;
    if (this.flight.size >= config.maxConcurrentSubagents) return;
    this.flight.set(toolUseId, { key });
  }
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
  private gate = new DelegationGateImpl();

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
      (toolName, input, agent) => this.requests.requestPermission(toolName, input, agent),
      this.gate,
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
          onUsage: (usage, cumulative) => this.recordUsage(usage, cumulative),
          onTurnEnd: (queued) => {
            // 回合结束：引擎队列里还有用户消息（背靠背排队的、回合中补充
            // 但未并入的）时引擎马上继续跑，保持 busy——既不清热会话回收
            // 计时器，也不让配置变更把正在处理的会话拆掉。队列空了才标记
            // 空闲：disposeIdleSessions（更换 LLM/MCP 配置后调用）才能回收
            // 热会话，让下一条消息按新配置 resume 重建。（此前 busy 在引擎
            // 循环存活期间一直为 true，配置变更永远跳过热会话。）
            // turnQueue.pending 只覆盖「服务端还没写进引擎」的那部分，
            // 引擎自己队列里的由 queued_turn_count 反映。
            const engineQueued = (queued ?? 0) > 0;
            this.busy = engineQueued || this.turnQueue.pending > 0;
            this.turnActive = false;
            this.gate.resetTurn();
            // 队列空了才解除看门狗：后续回合会接着来（引擎队列里排队，或
            // 服务端 TurnQueue 里还没写入引擎），此时仍处在一段工作期内，
            // 卡死同样要能被判死。
            if (this.busy) {
              // 后续回合接着来：看门狗重新计时（不靠用户催促续期），
              // 空闲回收计时器要清掉——引擎正在工作，不能被当成空闲拆掉。
              this.turnActive = true;
              this.armWatchdog();
              this.touch();
            } else {
              this.disarmWatchdog();
              this.scheduleIdleClose();
            }
          },
          onDelegateStart: (toolUseId, key) => this.gate.ensure(toolUseId, key),
          onDelegateEnd: (toolUseId) => this.gate.releaseToolUse(toolUseId),
          onTaskStarted: (taskId, toolUseId, key) =>
            this.gate.markTaskStarted(taskId, toolUseId, key),
          onTaskNotification: (taskId) => this.gate.releaseTask(taskId),
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
    // 先读 fresh record 只改目标字段再回写：内存 record 可能落后于磁盘
    // （会话存活期间协作流会给 record 并发写入 task_id/shared_with 等，
    // 整对象回写会把那些变更覆盖掉）。
    const fresh = this.store.getSession(this.record.session_id);
    const rec = fresh ?? this.record;
    rec.engine_session_id = engineSessionId;
    this.record.engine_session_id = engineSessionId;
    this.store.saveSession(rec);
  }

  /** 记录本会话 token 用量（每条回复一次，随 record 落库并出现在会话 meta）。
   *  cumulative=true：modelUsage 口径，本身就是会话累计值——替换而非累加；
   *  否则（老 CLI 的逐回合 usage）按原逻辑累加。与 persistEngineSessionId
   *  同理：基于 fresh record 改目标字段，防覆盖并发写入。 */
  private recordUsage(usage: Usage, cumulative?: boolean): void {
    const fresh = this.store.getSession(this.record.session_id);
    const rec = fresh ?? this.record;
    const prev = rec.usage;
    if (cumulative) {
      rec.usage = usage;
    } else {
      rec.usage = {
        input_tokens: (prev?.input_tokens ?? 0) + usage.input_tokens,
        output_tokens: (prev?.output_tokens ?? 0) + usage.output_tokens,
        cost_usd:
          prev?.cost_usd != null || usage.cost_usd != null
            ? (prev?.cost_usd ?? 0) + (usage.cost_usd ?? 0)
            : null,
      };
    }
    this.record.usage = rec.usage;
    this.store.saveSession(rec);
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
    this.turnActive = true;
    this.armWatchdog();
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
    this.idleTimer = setTimeout(() => this.idleCloseCheck(), config.sessionIdleMs);
    this.idleTimer.unref();
  }

  /** 到期回收：有在飞委派（后台子代理）时不回收——后台子代理活得比回合久，
   *  静默不代表工作结束；30s 后复查，全部结算后才真正 dispose。 */
  private idleCloseCheck(): void {
    if (this.disposed) return;
    if (this.gate.inFlight > 0) {
      this.idleTimer = setTimeout(() => this.idleCloseCheck(), 30_000);
      this.idleTimer.unref();
      return;
    }
    this.dispose();
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
