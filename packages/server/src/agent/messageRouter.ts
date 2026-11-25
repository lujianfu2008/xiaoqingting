import type { AttachmentImage, Block } from "@blm/protocol";
import { Store, sharedWithUser, type SessionRecord } from "../store.js";
import { listSkills } from "../skillsConfig.js";
import { mergeMcpServers } from "../mcpConfig.js";
import { AgentSession } from "./AgentSession.js";
import { recallFromEngineTranscript } from "./engineTranscript.js";
import type { ConnectionRegistry } from "./connections.js";
import type { TaskManager } from "./taskManager.js";
import type { UpdateRequestManager } from "./updateRequests.js";

// WS message routing: chat turns, interrupts, permission answers and local
// execution results, each gated by session ownership/sharing. 协作流任务线程
// 的执行面（发言守卫/审批/本机执行/中断）跟随当前负责人（工作台跟随指派）。

export class MessageRouter {
  private store: Store;
  private conns: ConnectionRegistry;
  private sessions: Map<string, AgentSession>;
  /** 最近收到的 user_message 确认 id → 时间戳。客户端网络抖动时自动重发同一条
   *  消息（同一 client_msg_id），这里幂等：重复到达只补发确认回显，绝不重跑
   *  引擎回合（否则一次抖动宕出两条回复）。键 = `${sessionId}:${clientMsgId}`，
   *  id 是客户端 UUID 本就不撞，键再按会话隔离更稳；条目按最近 5 分钟滚动清理。 */
  private recentMsgIds = new Map<string, number>();
  private static readonly RECENT_MSG_TTL_MS = 5 * 60_000;
  private recentMsgKey(sessionId: string, clientMsgId: string): string {
    return `${sessionId}:${clientMsgId}`;
  }
  /** sessionId → 最近一条用户消息的发送者。**仅用于中断权**：
   *  普通共享会话里提问的协作者能停掉自己发起的回合。执行面
   *  （本机执行）不跟随发言人——共享会话一律钉死会话主人，使用方
   *  只是借用宿主的能力与信息，不能把文件/命令操作引到自己机器上。 */
  private lastSpeaker = new Map<string, string>();

  constructor(
    store: Store,
    conns: ConnectionRegistry,
    sessions: Map<string, AgentSession>,
    private updateRequests: UpdateRequestManager,
    private tasks: TaskManager,
  ) {
    this.store = store;
    this.conns = conns;
    this.sessions = sessions;
  }

  /** 当前负责人（无任务回退主人）。执行面（本机执行/审批/快速失败）
   *  的目标用户：协作任务会话跟随任务当前负责人（工作台跟随指派）；
   *  共享会话一律钉死会话主人——使用方只是借用宿主的能力与信息，
   *  绝不能让宿主的会话把文件/命令操作落到自己的机器、污染自己的
   *  工作目录。 */
  private executorOf(sessionId: string, rec: { user_id: string }): string {
    return this.tasks.executorOf(sessionId) ?? rec.user_id;
  }

  /** 最近发言人（无记录为 null）。只用于中断权，不用于执行面。 */
  lastSpeakerOf(sessionId: string): string | null {
    return this.lastSpeaker.get(sessionId) ?? null;
  }

  /** 访问守卫（主人恒可发言；其他成员仅共享会话可发言）。 */
  private checkAccess(
    userId: string,
    sessionId: string,
  ): SessionRecord | null {
    const rec = this.store.getSession(sessionId);
    // The owner can always chat; other users only in sessions shared with them.
    if (!rec || (rec.user_id !== userId && !(rec.shared && sharedWithUser(rec, userId)))) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "session_not_found",
        message: "会话不存在或无权访问。",
      });
      return null;
    }

    // 协作者要推进线程，得有人能应答审批/本机执行——即当前负责人。负责人
    // 不在线时快速失败（owner 与负责人本人始终可发言），避免引擎卡在本机
    // 执行超时上。
    const executor = this.executorOf(sessionId, rec);
    if (
      rec.user_id !== userId &&
      userId !== executor &&
      !this.conns.isOnline(executor)
    ) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "executor_offline",
        message:
          executor === rec.user_id
            ? "会话主人当前不在线，暂时无法发言，请稍后再试。"
            : "当前负责人不在线，暂时无法发言，请稍后再试。",
      });
      return null;
    }
    return rec;
  }

  /** 记录驱动者：**仅中断权**——普通共享会话里提问的协作者能停掉
   *  自己发起的回合（执行面不跟随此记录，见 executorOf）。 */
  private recordSpeaker(rec: SessionRecord, userId: string, sessionId: string): void {
    this.lastSpeaker.set(sessionId, userId);
  }

  /**
   * 斜杠呼叫：消息以 /name 开头时按**会话主人**的生效视图（全局+我的同名
   * 覆盖）解析呼叫对象——专家技能优先，其次 MCP 服务器（enabled=false 的
   * 不认）——把发给引擎的提示词改写为「先加载/优先使用该能力再办事」。
   * 落库/回显/标题一律保持用户原文；名字不存在（或纯文本撞车）→ 原文
   * 透传，不打扰普通输入。按主人查（而非发言人）：共享会话借用宿主的
   * 能力——技能与 MCP 面本就只挂主人的。技能与 MCP 同名时技能优先。
   */
  private slashPromptFor(ownerUsername: string, text: string): string | null {
    const m = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?=\s|$)([\s\S]*)$/.exec(text);
    if (!m) return null;
    const ask = m[2].trim();
    const askLine = ask ? `用户请求：\n${ask}` : "用户没有附加要求，直接开始。";
    const skill = listSkills(ownerUsername).find((s) => s.name === m[1] && s.enabled !== false);
    if (skill) {
      return [
        `用户通过 /${skill.name} 呼叫专家技能「${skill.title || skill.name}」。`,
        `请先调用 Skill 工具加载技能 ${skill.name}，然后严格按该技能的指令处理。`,
        askLine,
      ].join("\n");
    }
    const mcp = mergeMcpServers(ownerUsername).servers[m[1]];
    if (mcp && mcp.enabled !== false) {
      return [
        `用户通过 /${m[1]} 呼叫 MCP 服务器 ${m[1]}。`,
        `请优先使用该服务器提供的工具（工具名形如 mcp__${m[1]}__*）完成请求。`,
        askLine,
      ].join("\n");
    }
    return null;
  }

  /** Handle a user chat message over WS. Lazily (re)starts the session loop, resuming engine state. */
  handleUserMessage(userId: string, sessionId: string, text: string, clientMsgId?: string): void {
    const rec = this.checkAccess(userId, sessionId);
    if (!rec) return;

    // 幂等护栏：带 client_msg_id 的 client（现代客户端都带）若同 id 刚来过
    // （自动重发/断线重连重发），只补发确认回显，不追加历史、不重跑引擎
    // ——否则一次网络抖动会把同一条消息撞出两条回复。TTL 内滚动清理。
    if (clientMsgId) {
      const now = Date.now();
      this.recentMsgIds.forEach((ts, id) => {
        if (now - ts > MessageRouter.RECENT_MSG_TTL_MS) this.recentMsgIds.delete(id);
      });
      const key = this.recentMsgKey(sessionId, clientMsgId);
      if (this.recentMsgIds.has(key)) {
        // 重复到达只把确认回显补发给发送方本人（协作者在首次到达时已收到，
        // 再发会让他们时间线上出现重复）。发送方客户端按 id 幂等合并（见
        // messages.ts），绝不重复上屏。
        this.conns.broadcast(userId, {
          type: "message_block",
          session_id: sessionId,
          block: { kind: "user_text", text, client_msg_id: clientMsgId },
        });
        return;
      }
      this.recentMsgIds.set(key, now);
    }

    // First user message becomes the session title.
    if (rec.title === "新对话") {
      rec.title = text.slice(0, 40);
      rec.updated_at = new Date().toISOString();
      this.store.saveSession(rec);
      this.conns.broadcastShared(rec.user_id, sessionId, {
        type: "session_created",
        session: {
          session_id: rec.session_id,
          title: rec.title,
          agent_id: rec.agent_id,
          created_at: rec.created_at,
          updated_at: rec.updated_at,
          project_id: rec.project_id ?? null,
          shared: rec.shared ?? false,
          shared_with: rec.shared_with ?? [],
          ...(rec.approvers?.length ? { approvers: rec.approvers } : {}),
          owner: rec.user_id,
        },
      });
    }
    rec.updated_at = new Date().toISOString();
    this.store.saveSession(rec);
    // 记录驱动者（仅中断权）：本会话的回合可被此用户中断。
    this.recordSpeaker(rec, userId, sessionId);
    const userBlock = {
      kind: "user_text",
      text,
      ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
    } as const;
    this.store.appendBlocks(sessionId, [userBlock]);
    // Echo the message to the owner and (if shared) every connected user, so
    // collaborators see each other's messages live. The sender's client skips
    // its local echo when this arrives.
    this.conns.broadcastShared(rec.user_id, sessionId, {
      type: "message_block",
      session_id: sessionId,
      block: userBlock,
    });

    // 斜杠呼叫专家：引擎提示词按技能改写（落库的 userBlock 仍是原文）。
    this.sessionOf(rec, sessionId).sendUserMessage(
      this.slashPromptFor(rec.user_id, text) ?? text,
    );
  }

  /** 重新生成：对最后一条用户消息再跑一轮回复。 */
  handleRegenerate(userId: string, sessionId: string): void {
    const rec = this.checkAccess(userId, sessionId);
    if (!rec) return;
    // 原文取自已落库历史：不追加新 user_text 块（聊天记录不重复），
    // 引擎按既有上下文对同一提问重新作答。
    const lastUser = this.lastUserText(sessionId);
    if (lastUser === null) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "session_not_found",
        message: "会话还没有可重新回答的消息。",
      });
      return;
    }
    this.store.saveSession(rec);
    // 记录驱动者（仅中断权）。
    this.recordSpeaker(rec, userId, sessionId);
    const session = this.sessionOf(rec, sessionId);
    // 重新生成同样走斜杠改写：原文里的 /name 在引擎侧语义不变。
    session.sendUserMessage(this.slashPromptFor(rec.user_id, lastUser) ?? lastUser);
  }

  /** 最后一条用户消息原文（剥离附件行）；还没有用户消息时为 null。 */
  private lastUserText(sessionId: string): string | null {
    const blocks = this.store.getHistory(sessionId);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind !== "user_text") continue;
      // [附件] 行是发送时的传输编码（文件路径），重新生成时剥掉。
      const text = b.text
        .split("\n")
        .filter((l) => !/^\[附件\]\s*.+→/.test(l))
        .join("\n")
        .trim();
      return text.length > 0 ? text : null;
    }
    return null;
  }

  /**
   * 撤回消息（任意位置回退）：删除第 ordinal 条用户消息**及其后所有
   * 内容**——之后的回复都被它影响过，单删它留着被污染的回复没有意义。
   * 两层同步裁剪：引擎转录（决定后续会话质量）+ 服务端聊天记录（用户
   * 看到的）。撤回前先摘掉空闲的引擎会话循环（它可能还持有转录文件），
   * 撤回后下一条消息按 engine_session_id resume 重建，撤回点之前的
   * 上下文一点不丢。仅会话主人可撤回；回合进行中拒绝。
   */
  async handleRecallMessage(
    userId: string,
    sessionId: string,
    ordinal: number,
    prefix: string,
  ): Promise<void> {
    const rec = this.checkAccess(userId, sessionId);
    if (!rec) return;
    if (rec.user_id !== userId) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "recall_denied",
        message: "只有会话主人可以撤回消息。",
      });
      return;
    }
    const live = this.sessions.get(sessionId);
    if (live?.isBusy) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "recall_busy",
        message: "回复进行中，等结束后再撤回。",
      });
      return;
    }

    const blocks = this.store.getHistory(sessionId);
    const userTexts: { block: Block; index: number }[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].kind === "user_text") userTexts.push({ block: blocks[i], index: i });
    }
    const target = userTexts[ordinal];
    // 客户端列表可能已过期（别处刚发过消息）：前缀对不上就拒绝，
    // 让客户端刷新后重试——绝不按序号盲删。
    if (
      !target ||
      target.block.kind !== "user_text" ||
      prefix.length === 0 ||
      target.block.text.slice(0, prefix.length) !== prefix
    ) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "recall_stale",
        message: "会话内容已变化，请重新打开会话后再试。",
      });
      return;
    }
    const kept = blocks.slice(0, target.index);

    // 摘掉空闲会话循环并等引擎进程死透：引擎退出时会回写整份转录，
    // 不等死透就手术，裁掉的内容会被原样写回（见 disposeAsync）。
    if (live) {
      await live.disposeAsync();
      this.sessions.delete(sessionId);
    }

    // 引擎转录手术：定位失败（如已被会话压缩折叠进摘要）时整个撤回
    // 拒绝——宁可不做，不留「显示删了、引擎还记得」的半吊子状态。
    if (rec.engine_session_id) {
      const outcome = await recallFromEngineTranscript({
        engineSessionId: rec.engine_session_id,
        ordinal,
        blockTexts: userTexts.slice(0, ordinal + 1).map((x) => (x.block as { text: string }).text),
      });
      if (outcome === "match_failed") {
        this.conns.broadcast(userId, {
          type: "error",
          session_id: sessionId,
          code: "recall_failed",
          message: "无法在会话上下文中定位该消息（可能已被压缩折叠），暂不能撤回；可新开会话替代。",
        });
        return;
      }
      if (outcome === "reset" || outcome === "file_missing") {
        // 转录已删/本就没有：引擎会话作废，下一条消息全新开始。
        const fresh = this.store.getSession(sessionId);
        if (fresh) {
          fresh.engine_session_id = null;
          this.store.saveSession(fresh);
        }
      }
      // 文件级手术要有痕：落日志便于诊断（不含消息内容）。
      console.log(`[recall] session=${sessionId} ordinal=${ordinal} transcript=${outcome}`);
    }

    this.store.setHistory(sessionId, kept);
    // 全量补发给主人与共享可见用户：客户端整表替换本地缓存。
    this.conns.broadcastShared(rec.user_id, sessionId, {
      type: "history_truncated",
      session_id: sessionId,
      blocks: kept,
    });
  }

  /** Lazily (re)start the session loop, resuming engine state. */
  private sessionOf(rec: SessionRecord, sessionId: string): AgentSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const created = new AgentSession(
        rec,
        this.store,
        {
          send: (msg) => this.conns.broadcastShared(rec.user_id, sessionId, msg),
          // 本机执行的 fail-fast 判的是执行目标在线状态（任务负责人
          // 或会话主人，随指派动态变化，故每次调用现查）。
          isExecutorOnline: () =>
            this.conns.isOnline(this.executorOf(sessionId, rec)),
          // 空闲回收/引擎退出时把会话从 Map 摘除：下一条消息走新建 + resume，
          // 而不是把消息推进死队列被静默吞掉。中断权记录一并清掉
          // （会话重开后由下一条消息重新记录）。
          onDispose: () => {
            if (this.sessions.get(sessionId) === created) this.sessions.delete(sessionId);
            this.lastSpeaker.delete(sessionId);
          },
          // 全部回合清空（真正空闲）：远程诊断任务据此结算报告。
          onIdle: () => this.onIdleHook?.(sessionId),
        },
        this.updateRequests,
      );
      session = created;
      this.sessions.set(sessionId, created);
    }
    return session;
  }

  /** 远程诊断任务的空闲结算钩子（DiagTaskManager 注入；
   *  无任务时为空函数，零开销）。 */
  onIdleHook: (sessionId: string) => void = () => {};

  handleInterrupt(userId: string, sessionId: string): void {
    const rec = this.store.getSession(sessionId);
    if (!rec) return;
    // 可中断者：主人、任务当前负责人（工作台跟随指派，本机执行落
    // 在谁头上谁就要能停），以及最近发言人——普通共享会话里提问的
    // 协作者由此能停掉自己发起的回合（中断权独立于执行面）。
    const target = this.executorOf(sessionId, rec);
    const speaker = this.lastSpeakerOf(sessionId);
    if (rec.user_id !== userId && userId !== target && userId !== speaker) {
      // 明确反馈而非静默丢弃。session_id 置 null：带 session_id 的
      // error 会把客户端该会话的 busy 复位，而回合还在跑。
      if (rec.shared && sharedWithUser(rec, userId)) {
        this.conns.broadcast(userId, {
          type: "error",
          session_id: null,
          code: "interrupt_denied",
          message: "只有会话主人或当前驱动者可以停止本次回答。",
        });
      }
      return;
    }
    void this.sessions.get(sessionId)?.interrupt();
  }

  handlePermissionResponse(userId: string, requestId: string, allow: boolean): void {
    const sid = requestId.split(":")[0];
    const rec = sid ? this.store.getSession(sid) : null;
    if (!rec) return;
    // 可应答者：主人、被授权的审批人（approvers，且须共享可见）、当前负责人
    // （工作台跟随指派）。先到先结算，后到的应答在 PendingMap 上是 no-op。
    const isApprover =
      rec.user_id !== userId &&
      (rec.approvers ?? []).includes(userId) &&
      rec.shared &&
      sharedWithUser(rec, userId);
    const isExecutor = this.executorOf(sid, rec) === userId;
    if (rec.user_id !== userId && !isApprover && !isExecutor) return;
    this.sessions.get(sid)?.respondPermission(requestId, allow);
  }

  /** Route a client's local-execution result back to the waiting session. */
  handleToolExecResult(
    userId: string,
    requestId: string,
    result: { ok: boolean; output?: string; error?: string; images?: AttachmentImage[] },
  ): void {
    const sid = requestId.split(":")[0];
    const rec = sid ? this.store.getSession(sid) : null;
    if (!rec) return;
    // 结果来自当前执行目标（任务负责人，否则会话主人）的客户端；主人
    // 以外的应答按目标比对——防流转瞬间的边界下（请求发给旧目标、
    // 应答迟到）结果被静默丢弃。
    const target = this.executorOf(sid, rec);
    if (rec.user_id !== userId && userId !== target) return;
    this.sessions.get(sid)?.respondExec(requestId, result);
  }
}
