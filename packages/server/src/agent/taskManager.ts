import type { FlowAction, ServerMessage, TaskStatus } from "@blm/protocol";
import crypto from "node:crypto";
import { Store, type SessionRecord, type TaskRecord } from "../store.js";
import { getUserRecord } from "../users.js";
import type { ConnectionRegistry } from "./connections.js";
import type { SessionRegistry } from "./sessionRegistry.js";

// 团队协作流（需求 → 研发 → 测试）：任务线程 = 需求方的绑定会话 + TaskRecord 状态机。
// 鉴权矩阵的执法唯一在服务端 flow()；客户端按角色显隐按钮只是体验。
// 推送面：task_update 定向推任务相关人（去重），flow_event 进会话历史并经
// broadcastShared 到所有共享可见的在线用户（兼作时间线与凭证）。

export interface CreateTaskInput {
  title: string;
  description?: string;
  agent_id?: string;
}

export interface TaskFlowInput {
  action: FlowAction;
  target?: string;
  note?: string;
}

export type FlowResult =
  | { ok: true; rec: TaskRecord }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "bad_status" | "bad_target" | "bad_request";
      message: string;
    };

export class TaskManager {
  constructor(
    private store: Store,
    private conns: ConnectionRegistry,
    private registry: SessionRegistry,
  ) {}

  /**
   * 创建任务线程。顺序即回滚策略：先建会话再写任务（孤儿空会话无害，
   * 反过来孤儿任务危害大）。会话标题即任务名，天然免疫首条消息改标题逻辑。
   */
  createTask(requester: string, input: CreateTaskInput): TaskRecord {
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
      status: "analyzing",
      session_id: session.session_id,
      requester,
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
   * 流转守卫矩阵（唯一执法点）：
   * | action        | from               | actor            | target    | note   | to        |
   * | assign_dev    | analyzing          | requester        | 必填      | —      | developing|
   * | submit_test   | developing         | dev              | 可选      | 可选   | testing   |
   * | assign_tester | testing            | dev 或 requester | 必填      | —      | testing   |
   * | report_issue  | testing 且tester已设| 恰为 tester      | —         | 必填   | fixing    |
   * | resubmit      | fixing             | dev              | —         | 可选   | testing   |
   * | pass          | testing 且tester已设| 恰为 tester      | —         | 可选   | done      |
   * fixing 唯一出口是 resubmit，循环无限制。
   */
  flow(actor: string, taskId: string, input: TaskFlowInput): FlowResult {
    const rec = this.store.getTask(taskId);
    if (!rec) return { ok: false, code: "not_found", message: "任务不存在。" };
    const from = rec.status;
    const isRequester = actor === rec.requester;
    const isDev = rec.dev != null && actor === rec.dev;
    const isTester = rec.tester != null && actor === rec.tester;

    const forbidden = (): FlowResult => ({
      ok: false,
      code: "forbidden",
      message: "您没有执行该流转的权限。",
    });
    const badStatus = (required: TaskStatus): FlowResult => ({
      ok: false,
      code: "bad_status",
      message: `任务当前状态不允许该操作（需 ${statusLabel(required)} 阶段）。`,
    });
    const noTester = (): FlowResult => ({
      ok: false,
      code: "bad_status",
      message: "尚未指派测试，无法执行该操作。",
    });
    // 目标用户必须存在、已过审且未禁用。
    const checkTarget = (t: string): FlowResult | { ok: true } => {
      const u = getUserRecord(t);
      if (!u || u.status !== "approved" || u.disabled) {
        return { ok: false, code: "bad_target", message: `用户 ${t} 不存在或当前不可用。` };
      }
      return { ok: true };
    };

    let next: TaskStatus;
    let targets: string[] = [];
    switch (input.action) {
      case "assign_dev": {
        if (from !== "analyzing") return badStatus("analyzing");
        if (!isRequester) return forbidden();
        const t = input.target?.trim();
        if (!t) {
          return { ok: false, code: "bad_request", message: "请选择要指派的研发。" };
        }
        const ok = checkTarget(t);
        if (!ok.ok) return ok;
        rec.dev = t;
        targets = [t];
        next = "developing";
        break;
      }
      case "submit_test": {
        if (from !== "developing") return badStatus("developing");
        if (!isDev) return forbidden();
        const t = input.target?.trim();
        if (t) {
          // 可选：提测时预先指定测试。
          const ok = checkTarget(t);
          if (!ok.ok) return ok;
          rec.tester = t;
          targets = [t];
        }
        next = "testing";
        break;
      }
      case "assign_tester": {
        if (from !== "testing") return badStatus("testing");
        if (!isDev && !isRequester) return forbidden();
        const t = input.target?.trim();
        if (!t) {
          return { ok: false, code: "bad_request", message: "请选择要指派的测试。" };
        }
        const ok = checkTarget(t);
        if (!ok.ok) return ok;
        rec.tester = t;
        targets = [t];
        next = "testing";
        break;
      }
      case "report_issue": {
        if (from !== "testing") return badStatus("testing");
        if (!rec.tester) return noTester();
        if (!isTester) return forbidden();
        if (!input.note?.trim()) {
          return { ok: false, code: "bad_request", message: "请描述测试发现的问题。" };
        }
        next = "fixing";
        break;
      }
      case "resubmit": {
        if (from !== "fixing") return badStatus("fixing");
        if (!isDev) return forbidden();
        next = "testing";
        break;
      }
      case "pass": {
        if (from !== "testing") return badStatus("testing");
        if (!rec.tester) return noTester();
        if (!isTester) return forbidden();
        next = "done";
        break;
      }
    }

    rec.status = next;
    rec.updated_at = new Date().toISOString();
    this.store.saveTask(rec);
    this.appendFlowEvent(rec, actor, input.action, from, next, targets, input.note?.trim() || undefined);
    if (targets.length > 0) this.autoShare(rec, targets);
    this.notify(rec);
    return { ok: true, rec };
  }

  /** 我的任务列表（需求方/研发/测试任一角色命中）。 */
  listFor(userId: string): TaskRecord[] {
    return this.store
      .listTasks()
      .filter((t) => t.requester === userId || t.dev === userId || t.tester === userId);
  }

  /** 未完结任务（WS 连接建立补推用）。 */
  activeFor(userId: string): TaskRecord[] {
    return this.listFor(userId).filter((t) => t.status !== "done");
  }

  getTask(taskId: string): TaskRecord | null {
    return this.store.getTask(taskId);
  }

  /** 流转事件写进会话历史（时间线），并广播给所有共享可见用户。 */
  private appendFlowEvent(
    rec: TaskRecord,
    actor: string,
    action: FlowAction,
    from: TaskStatus,
    to: TaskStatus,
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
      from_status: from,
      to_status: to,
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
   * 指派自动共享：把新角色并入 shared_with（保留既有名单）。已是「全员共享」
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

  /** task_update 定向推给相关人（去重）。 */
  private notify(rec: TaskRecord): void {
    const msg: ServerMessage = { type: "task_update", task: rec };
    for (const u of new Set([rec.requester, rec.dev, rec.tester].filter((u): u is string => !!u))) {
      this.conns.broadcast(u, msg);
    }
  }
}

function statusLabel(s: TaskStatus): string {
  return { analyzing: "需求分析", developing: "研发中", fixing: "修复中", testing: "测试中", done: "已完成" }[s];
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
