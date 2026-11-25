import fs from "node:fs";
import path from "node:path";
import type { DiagTaskEntry, DiagTaskKind } from "@blm/protocol";
import type { AgentManager } from "./agent/AgentManager.js";
import type { Store } from "./store.js";
import { config } from "./config.js";

// 远程诊断任务：管理员借用在线客户端的智能体排障。
// 会话归属目标用户（其 LLM 配置、其本机工具面），管理员只发起
// 与读报告，不进会话、不收消息流。提示词按模板生成（管理员
// 不写自由文本，防滥用），且明确只读探查边界。最终报告取
// 会话历史的 text 块落 data/diag-tasks/，超时兜底强收。

const MAX_ENTRIES = 30;
// 15 分钟：模板有 4 组命令，而目标用户的 LLM 可能走网络中继
// （admin 真机 8 分钟只跑了 6 次 LLM 调用，8 分钟死线连续三连超时）。
// 看门狗死线与这里互不相干：该会话是独立会话，只受本死线约束。
const TURN_TIMEOUT_MS = 15 * 60_000;

function taskDir(): string {
  return path.join(config.dataDir, "diag-tasks");
}

interface StoredTask extends DiagTaskEntry {
  report?: string;
}

// 提示词模板（按 kind）。只读探查：明确禁止写文件/改配置/
// 执行有副作用的命令，工具审批仍走既有 canUseTool 门。
// 教训：不允许「描述你看到的现象」一类开放观察——智能体没有
// 眼睛，会一头扎进 UI 自动化/截图的死角烧光回合限额
// （两次 8 分钟超时都是它）。步骤必须全是它能真正执行的。
const PROMPTS: Record<DiagTaskKind, string> = {
  display_layout: [
    "这是一次只读的显示排障任务，请严格按要求执行。你观察不到屏幕画面（不要尝试截图、UI 自动化或读窗口坐标——那会浪费时限），只能跑命令读文件。",
    "请依次完成：",
    "1. 用 run_command 执行 reg query \"HKCU\\Control Panel\\Desktop\\WindowMetrics\" /v AppliedDPI 与 reg query \"HKCU\\Control Panel\\Desktop\" /v DpiScalingVal，报告输出。",
    "2. 用 run_command 执行 PowerShell \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Format-List *\"，报告每块屏的 Bounds 与 DeviceName（这是 DPI 感知的真实分辨率）。",
    "3. 用 list_dir 和 read_file 查看 %APPDATA% 下与小蜻蜓相关的配置目录里的 settings.json，报告其中与窗口/布局相关的键值。",
    "4. 用 run_command 执行 reg query \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\PerMonitorSettings\" /s（若存在），报告每显示器的 DpiValue 偏移。",
    "把以上结果整理成一份简明报告（注明哪条命令失败/输出为空）。全程不要写文件、不要改任何配置、不要安装任何东西、不要尝试任何屏幕截图或窗口测量。",
  ].join("\n"),
};

export class DiagTaskManager {
  private store: Store;
  private manager: AgentManager;
  // task_id → 超时句柄。
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(store: Store, manager: AgentManager) {
    this.store = store;
    this.manager = manager;
  }

  private loadAll(): Record<string, StoredTask> {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(taskDir(), "index.json"), "utf8"),
      ) as Record<string, StoredTask>;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private saveAll(all: Record<string, StoredTask>): void {
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.writeFileSync(
      path.join(taskDir(), "index.json"),
      JSON.stringify(all, null, 2),
      { mode: 0o600 },
    );
  }

  /** 发起：目标用户必须在线。建会话（归属目标用户）、喂提示词、
   *  登记超时。最终报告由 finalize 从历史提取。 */
  start(
    actor: string,
    username: string,
    kind: DiagTaskKind,
  ): { ok: true; task_id: string; session_id: string } | { ok: false; code: string } {
    if (!this.manager.isOnline(username)) return { ok: false, code: "user_offline" };
    const rec = this.store.createSession(
      username,
      "coder",
      "显示诊断（管理员发起）",
      null,
    );
    const taskId = `dt${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const entry: StoredTask = {
      task_id: taskId,
      username,
      session_id: rec.session_id,
      kind,
      status: "running",
      at: new Date().toISOString(),
    };
    const all = this.loadAll();
    all[taskId] = entry;
    this.prune(all);
    this.saveAll(all);
    // 喂任务：服务端直接以「会话主人身份」驱动该会话。
    this.manager.handleUserMessage(username, rec.session_id, PROMPTS[kind]);
    // 超时兜底：引擎卡死/用户下线时强收，报告留现场摘要。
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      void this.finalize(taskId, "timeout");
    }, TURN_TIMEOUT_MS);
    timer.unref();
    this.timers.set(taskId, timer);
    // 发起审计由 REST 层写（有 req 上下文）；这里留运行痕迹。
    console.log(
      `[diag-task] ${taskId} started by ${actor} on ${username} (session ${rec.session_id})`,
    );
    return { ok: true, task_id: taskId, session_id: rec.session_id };
  }

  /** 回合结束钩子：从会话历史取最后一段 text 块存档。 */
  onTurnEnd(taskId: string): void {
    void this.finalize(taskId, "done");
  }

  private async finalize(
    taskId: string,
    status: "done" | "timeout",
  ): Promise<void> {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    const all = this.loadAll();
    const entry = all[taskId];
    if (!entry || entry.status !== "running") return;
    const blocks = this.store.getHistory(entry.session_id);
    let report: string | null = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "text") {
        report = b.text;
        break;
      }
    }
    entry.status = status;
    entry.finished_at = new Date().toISOString();
    if (status === "timeout") {
      entry.note =
        report
          ? "回合超时，以下为当前已产出的内容。"
          : "回合超时且没有产出报告（引擎无响应或用户中途下线）。";
    }
    if (report) entry.report = report;
    this.saveAll(all);
    console.log(`[diag-task] ${taskId} ${status} (report: ${report ? report.length : 0} chars)`);
    // 报告已落存档；专属会话不留痕（用户列表里可见可删，见下）。
  }

  /** 用户（或管理员经管理页）清理：删任务记录与专属会话。 */
  delete(taskId: string, byUser: string): "ok" | "not_found" | "forbidden" {
    const all = this.loadAll();
    const entry = all[taskId];
    if (!entry) return "not_found";
    if (entry.username !== byUser) return "forbidden";
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    delete all[taskId];
    this.saveAll(all);
    // 会话是任务专属产物，一并收走（归属目标用户本人，无内容价值）。
    this.manager.deleteSession(entry.username, entry.session_id);
    return "ok";
  }

  /** 删除用户账号时级联：清掉其名下全部诊断任务的记录与专属会话。 */
  deleteForUser(username: string): void {
    const all = this.loadAll();
    const owned = Object.values(all).filter((e) => e.username === username);
    if (owned.length === 0) return;
    for (const e of owned) {
      const timer = this.timers.get(e.task_id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(e.task_id);
      }
      delete all[e.task_id];
    }
    this.saveAll(all);
    for (const e of owned) {
      this.manager.deleteSession(e.username, e.session_id);
    }
  }

  list(): DiagTaskEntry[] {
    return Object.values(this.loadAll())
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(({ report: _r, ...e }) => e);
  }

  detail(taskId: string): { entry: DiagTaskEntry; report: string | null } | null {
    const e = this.loadAll()[taskId];
    if (!e) return null;
    const { report, ...rest } = e;
    return { entry: rest, report: report ?? null };
  }

  /** 状态补推：WS 连接建立时管理员面板要能看到 running 任务的最新态。
   *  本处顺带结算已结束但未 finalize 的（进程重启遗留的 running）。 */
  sweepStale(): void {
    const all = this.loadAll();
    let changed = false;
    const now = Date.now();
    for (const e of Object.values(all)) {
      if (e.status !== "running") continue;
      if (now - new Date(e.at).getTime() > TURN_TIMEOUT_MS + 60_000) {
        e.status = "timeout";
        e.finished_at = new Date().toISOString();
        e.note = "进程重启导致任务中断。";
        changed = true;
      }
    }
    if (changed) this.saveAll(all);
  }

  private prune(all: Record<string, StoredTask>): void {
    const sorted = Object.entries(all).sort((a, b) => a[1].at.localeCompare(b[1].at));
    for (const [id] of sorted.slice(0, Math.max(0, sorted.length - MAX_ENTRIES))) {
      delete all[id];
    }
  }
}

/** 存档目录（ensureDataDirs 风格的预建）。 */
export function ensureDiagTaskDir(): void {
  fs.mkdirSync(taskDir(), { recursive: true });
}
