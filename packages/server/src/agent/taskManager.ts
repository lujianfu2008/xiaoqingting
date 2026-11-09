import type { FlowAction, ServerMessage, WorkflowStage } from "@blm/protocol";
import crypto from "node:crypto";
import { Store, type SessionRecord, type TaskRecord } from "../store.js";
import { getUserRecord } from "../users.js";
import { BUILT_IN_WORKFLOW, resolveTemplate } from "../workflowConfig.js";
import type { ConnectionRegistry } from "./connections.js";
import type { SessionRegistry } from "./sessionRegistry.js";

// 团队协作流（可自定义工作流模板）：任务线程 = 需求方的绑定会话 + TaskRecord
// 环节状态机。环节序列在建任务时从模板快照（此后模板编辑不影响在途任务），
// 负责人挂在环节 assignee 上。鉴权矩阵的执法唯一在服务端 flow()；客户端按
// 角色显隐按钮只是体验。推送面：task_update 定向推任务相关人（去重），
// flow_event 进会话历史并经 broadcastShared 到所有共享可见的在线用户。

export class TaskCreateError extends Error {
  constructor(public code: "bad_template" | "bad_target") {
    super(code);
  }
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  agent_id?: string;
  template_name?: string;
  assignees?: Record<string, string>;
}

export interface TaskFlowInput {
  action: FlowAction;
  target?: string;
  stage_key?: string;
  note?: string;
}

export type FlowResult =
  | { ok: true; rec: TaskRecord }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "bad_status" | "bad_target" | "bad_request";
      message: string;
    };

// 旧版五状态 → 内置模板环节 key（fixing 归入 dev 环节：旧 fixing 的唯一出口
// 是 resubmit→testing，且旧 executorOf(fixing)=dev，执行者等价）。迁移用。
const LEGACY_STAGE_OF: Record<string, string> = {
  analyzing: "requirement",
  developing: "dev",
  fixing: "dev",
  testing: "test",
};

/** 目标用户必须存在、已过审且未禁用。 */
function userUsable(t: string): boolean {
  const u = getUserRecord(t);
  return !!u && u.status === "approved" && !u.disabled;
}

export class TaskManager {
  constructor(
    private store: Store,
    private conns: ConnectionRegistry,
    private registry: SessionRegistry,
  ) {}

  /**
   * 创建任务线程。顺序即回滚策略：先建会话再写任务（孤儿空会话无害，
   * 反过来孤儿任务危害大）。会话标题即任务名，天然免疫首条消息改标题逻辑。
   * 环节快照：显式指派优先（空串 = 清空预置岗位），否则用模板预置。
   */
  createTask(requester: string, input: CreateTaskInput): TaskRecord {
    const tpl = resolveTemplate(requester, input.template_name);
    if (!tpl) throw new TaskCreateError("bad_template");
    const stages: WorkflowStage[] = tpl.stages.map((s) => {
      const raw = input.assignees?.[s.key];
      if (raw != null && !raw.trim()) return { key: s.key, name: s.name };
      const chosen = raw?.trim() ?? s.assignee;
      // 只有建任务时显式选择的人做可用性校验；模板预置原样带出（岗位上的
      // 人事后被禁用由需求方 assign 换人解卡，不在建任务时卡死）。
      if (chosen && !userUsable(chosen)) throw new TaskCreateError("bad_target");
      return chosen
        ? { key: s.key, name: s.name, assignee: chosen }
        : { key: s.key, name: s.name };
    });
    const session = this.registry.createSession(
      requester,
      input.agent_id ?? "assistant",
      input.title,
      null,
    );
    if (!session) {
      // projectId=null 不走项目校验，这里只是类型收窄的防御分支。
      throw new Error("task session create failed");
    }
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      task_id: crypto.randomUUID(),
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      status: "active",
      session_id: session.session_id,
      requester,
      template_name: tpl.name,
      stages,
      current_stage: stages[0].key,
      created_at: now,
      updated_at: now,
    };
    this.store.saveTask(rec);
    // 回写 session.task_id（只改目标字段，防整对象覆盖并发写入）。
    const fresh = this.store.getSession(session.session_id);
    if (fresh) {
      fresh.task_id = rec.task_id;
      this.store.saveSession(fresh);
    }
    this.conns.broadcast(requester, { type: "task_update", task: rec });
    return rec;
  }

  /**
   * 流转守卫矩阵（唯一执法点）。前置：任务在途（status==="active" 且
   * current_stage 可解析），否则 bad_status「任务已完结」。
   * | action    | actor                                | 参数                        | 效果 |
   * | advance   | 当前环节已设 assignee→恰为 assignee；  | —                           | 非末环节→下一环节；末环节→done |
   * |           | 未设→恰为 requester                   |                             |      |
   * | send_back | requester 或当前环节 assignee         | stage_key 必填且为之前的环节  | current_stage=stage_key（负责人保留） |
   * | assign    | requester 或当前环节 assignee         | stage_key 必填；target 必填可用 | stages[idx].assignee=target（autoShare） |
   * | cancel    | requester                             | —                           | done + cancelled |
   * 负责人驱动：已设负责人的环节只有负责人能推进（需求方要推进先把自己指派
   * 为负责人）；未设负责人的环节由需求方兜底推进。打回/指派允许落到从未指派
   * 的环节（executorOf 回退 requester）。
   */
  flow(actor: string, taskId: string, input: TaskFlowInput): FlowResult {
    const rec = this.store.getTask(taskId);
    if (!rec) return { ok: false, code: "not_found", message: "任务不存在。" };
    const isRequester = actor === rec.requester;

    const forbidden = (): FlowResult => ({
      ok: false,
      code: "forbidden",
      message: "您没有执行该流转的权限。",
    });
    // 目标用户必须存在、已过审且未禁用。
    const checkTarget = (t: string): FlowResult | { ok: true } => {
      if (!userUsable(t)) {
        return { ok: false, code: "bad_target", message: `用户 ${t} 不存在或当前不可用。` };
      }
      return { ok: true };
    };

    const curIdx = rec.stages.findIndex((s) => s.key === rec.current_stage);
    if (rec.status !== "active" || curIdx < 0) {
      return { ok: false, code: "bad_status", message: "任务已完结，无法继续流转。" };
    }
    const cur = rec.stages[curIdx];

    let targets: string[] = [];
    let toStage: string | undefined; // 落点环节名（完结/取消省略）
    switch (input.action) {
      case "advance": {
        if (cur.assignee ? cur.assignee !== actor : !isRequester) return forbidden();
        const next = rec.stages[curIdx + 1];
        if (next) {
          rec.current_stage = next.key;
          toStage = next.name;
        } else {
          rec.current_stage = null;
        }
        break;
      }
      case "send_back": {
        if (!isRequester && cur.assignee !== actor) return forbidden();
        const idx = rec.stages.findIndex((s) => s.key === input.stage_key?.trim());
        if (idx < 0) {
          return { ok: false, code: "bad_request", message: "请选择要打回到的环节。" };
        }
        if (idx >= curIdx) {
          return { ok: false, code: "bad_request", message: "只能打回到之前的环节。" };
        }
        rec.current_stage = rec.stages[idx].key;
        toStage = rec.stages[idx].name;
        break;
      }
      case "assign": {
        if (!isRequester && cur.assignee !== actor) return forbidden();
        const idx = rec.stages.findIndex((s) => s.key === input.stage_key?.trim());
        if (idx < 0) {
          return { ok: false, code: "bad_request", message: "环节不存在。" };
        }
        const t = input.target?.trim();
        if (!t) {
          return { ok: false, code: "bad_request", message: "请选择该环节的负责人。" };
        }
        const ok = checkTarget(t);
        if (!ok.ok) return ok;
        rec.stages[idx] = { ...rec.stages[idx], assignee: t };
        targets = [t];
        break;
      }
      case "cancel": {
        // 需求方放弃任务：任意在途状态可取消（否则卡住的线程既推不动也删不掉）。
        // 落 done，任务记录保留、时间线记录取消事件，协作端工作台随 task_update 摘除。
        if (!isRequester) return forbidden();
        rec.cancelled = true;
        rec.current_stage = null;
        break;
      }
    }

    if (rec.current_stage === null) rec.status = "done";
    rec.updated_at = new Date().toISOString();
    this.store.saveTask(rec);
    this.appendFlowEvent(rec, actor, input.action, cur.name, toStage, targets, input.note?.trim() || undefined);
    if (targets.length > 0) this.autoShare(rec, targets);
    this.notify(rec);
    return { ok: true, rec };
  }

  /** 我的任务列表（需求方/任一环节负责人命中）。 */
  listFor(userId: string): TaskRecord[] {
    return this.store
      .listTasks()
      .filter((t) => t.requester === userId || t.stages.some((s) => s.assignee === userId));
  }

  /** 未完结任务（WS 连接建立补推用）。 */
  activeFor(userId: string): TaskRecord[] {
    return this.listFor(userId).filter((t) => t.status !== "done");
  }

  getTask(taskId: string): TaskRecord | null {
    return this.store.getTask(taskId);
  }

  /**
   * 会话当前负责人：工作台跟随指派——agent 的本机执行、审批应答、发言守卫、
   * 中断权都跟随此用户，其桌面端所在机器就是当前工作台。当前环节负责人
   * 兜底需求方（环节未指派/负责人离线由需求方推进或换人）。无任务（或任务
   * 记录缺失）返回 null，调用方回退会话主人。
   */
  executorOf(sessionId: string): string | null {
    const taskId = this.store.getSession(sessionId)?.task_id;
    if (!taskId) return null;
    const rec = this.store.getTask(taskId);
    if (!rec) return null;
    if (rec.status !== "active" || !rec.current_stage) return rec.requester;
    const cur = rec.stages.find((s) => s.key === rec.current_stage);
    return cur?.assignee ?? rec.requester;
  }

  /**
   * 存量任务一次性迁移到 v2（模板快照表示）。幂等判据是 stages 字段（不能用
   * status——旧 done 与新 done 同值）。旧 fixing 归入 dev 环节（见
   * LEGACY_STAGE_OF 注释）。历史 flow_event 块不改写（客户端按 legacy 标签渲染）。
   */
  migrateLegacyTasks(): void {
    try {
      let migrated = 0;
      for (const old of this.store.listTasks()) {
        try {
          if (Array.isArray(old.stages) && old.stages.length > 0) continue;
          const legacy = old as TaskRecord & { dev?: string; tester?: string };
          const stages: WorkflowStage[] = BUILT_IN_WORKFLOW.stages.map((s) => ({ ...s }));
          const dev = stages.find((s) => s.key === "dev");
          const test = stages.find((s) => s.key === "test");
          if (legacy.dev && dev) dev.assignee = legacy.dev;
          if (legacy.tester && test) test.assignee = legacy.tester;
          const done = legacy.status === "done";
          const rec: TaskRecord = {
            task_id: legacy.task_id,
            title: legacy.title,
            ...(legacy.description ? { description: legacy.description } : {}),
            status: done ? "done" : "active",
            session_id: legacy.session_id,
            requester: legacy.requester,
            template_name: BUILT_IN_WORKFLOW.name,
            stages,
            current_stage: done
              ? null
              : LEGACY_STAGE_OF[legacy.status] ?? stages[0].key,
            created_at: legacy.created_at,
            updated_at: legacy.updated_at,
          };
          this.store.saveTask(rec);
          migrated++;
        } catch (err) {
          console.error("[task-migrate] 单条任务迁移失败（跳过）:", err);
        }
      }
      if (migrated > 0) console.log(`[task-migrate] 已迁移 ${migrated} 条存量任务到 v2。`);
    } catch (err) {
      // 迁移失败不阻断启动：失败的任务文件保持旧形状，下次启动重试。
      console.error("[task-migrate] 存量任务迁移中断:", err);
    }
  }

  /**
   * 流转事件写进会话历史（时间线），并广播给所有共享可见用户。新事件自带
   * 环节名（自包含，渲染无需反查任务）；from_status 恒为 active（完结由
   * to_status 表达）。
   */
  private appendFlowEvent(
    rec: TaskRecord,
    actor: string,
    action: FlowAction,
    fromStage: string,
    toStage: string | undefined,
    targets: string[],
    note?: string,
  ): void {
    const block = {
      kind: "flow_event" as const,
      id: crypto.randomUUID(),
      task_id: rec.task_id,
      task_title: rec.title,
      actor,
      action,
      from_status: "active",
      to_status: rec.status,
      from_stage_name: fromStage,
      ...(toStage ? { to_stage_name: toStage } : {}),
      ...(targets.length > 0 ? { targets } : {}),
      ...(note ? { note } : {}),
      ts: new Date().toISOString(),
    };
    this.store.appendBlocks(rec.session_id, [block]);
    this.conns.broadcastShared(rec.requester, rec.session_id, {
      type: "message_block",
      session_id: rec.session_id,
      block,
    });
  }

  /**
   * 指派自动共享：把新负责人并入 shared_with（保留既有名单）。已是「全员共享」
   * （shared 且空名单）则保持不动防收窄；不写 approvers；done 不取消共享。
   * 新共享者补推 session_created，客户端零新增代码即可看到线程。
   */
  private autoShare(rec: TaskRecord, users: string[]): void {
    const session = this.store.getSession(rec.session_id);
    if (!session) return;
    const current = session.shared_with ?? [];
    const merged = [...new Set([...current, ...users.filter((u) => u !== session.user_id)])];
    if (session.shared && current.length === 0) return; // 全员共享，不收窄
    if (session.shared && merged.length === current.length) return; // 无新增
    const updated = this.registry.setShared(
      session.user_id,
      rec.session_id,
      true,
      merged,
    );
    if (!updated) return;
    for (const u of users) {
      if (u === session.user_id || current.includes(u)) continue;
      this.conns.broadcast(u, { type: "session_created", session: metaOf(updated) });
    }
  }

  /** task_update 定向推给相关人（需求方 + 全部环节负责人，去重）。 */
  private notify(rec: TaskRecord): void {
    const msg: ServerMessage = { type: "task_update", task: rec };
    const people = new Set([
      rec.requester,
      ...rec.stages.map((s) => s.assignee).filter((u): u is string => !!u),
    ]);
    for (const u of people) this.conns.broadcast(u, msg);
  }
}

/** SessionMeta 手工投影（与 messageRouter 首条消息的 session_created 同构）。 */
function metaOf(rec: SessionRecord) {
  return {
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
  };
}
