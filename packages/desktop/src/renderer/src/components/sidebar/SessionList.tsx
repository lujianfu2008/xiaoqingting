import { useEffect, useRef, useState } from "react";
import type {
  Block,
  ProjectMeta,
  ScheduleView,
  SessionMeta,
  SessionSearchItem,
  TaskView,
} from "@blm/protocol";
import { useStore } from "../../store";
import { apiBase } from "../../store/http";
import { useT } from "../../i18n";
import { blocksToMarkdown } from "../../lib/exportMarkdown";
import { NewTaskDialog } from "./NewTaskDialog";
import { NewScheduleDialog } from "./NewScheduleDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

// My sessions grouped by project (default space last), then shared (read-only)
// sessions. The share/delete buttons live inside each row; both stop
// propagation so they don't select.
// 项目组会话可展开/收起（点组头箭头）：全局同时最多展开两个项目，
// 展开第三个时最早展开的自动收起；搜索过滤时强制全展开防命中被藏。

// 搜索命中片段：snippet 里命中词以 ** 包裹，拆开渲染高亮。
// 服务端已截好 ~60 字上下文，这里只做拆分。
function HighlightedSnippet({ snippet }: { snippet: string }): React.JSX.Element {
  const parts = snippet.split(/\*\*/);
  // split 把 ** 包裹的词放在奇数下标。
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} style={{ background: "rgba(229,168,58,.35)", color: "inherit" }}>
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

// 内容搜索结果行：会话标题 + 命中片段（高亮），点击进会话。
function SearchHitRow({ item, q }: { item: SessionSearchItem; q: string }): React.JSX.Element {
  const selectSession = useStore((s) => s.selectSession);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const t = useT();
  const first = item.matches[0];
  return (
    <div
      className={`session-item ${
        item.session_id === currentSessionId && !sharedView ? "active" : ""
      }`}
      data-session-row={item.session_id}
      title={t("sess.hitCount", { count: item.total })}
      onClick={() => void selectSession(item.session_id)}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className="title" style={{ color: "var(--text)" }}>{item.session_title}</span>
          <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
            {t("sess.hitCount", { count: item.total })}
          </span>
        </div>
        {first && (
          <div
            style={{
              fontSize: 11,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <HighlightedSnippet snippet={first.snippet} />
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  s,
  active,
  onShare,
  onMoveMenu,
}: {
  s: SessionMeta;
  active: boolean;
  onShare: (sessionId: string) => void;
  onMoveMenu?: (sessionId: string, x: number, y: number) => void;
}): React.JSX.Element {
  const selectSession = useStore((sel) => sel.selectSession);
  const deleteSession = useStore((sel) => sel.deleteSession);
  const renameSession = useStore((sel) => sel.renameSession);
  // 与 tab 同款：该会话后台回合进行中的小红点（不切过去也能看到）。
  const busy = useStore((sel) => sel.busy[s.session_id] ?? false);
  const t = useT();
  // 行内重命名：编辑态时标题变输入框（Enter/blur 提交，Esc 取消，空标题不提交）。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const startRename = (): void => {
    setDraft(s.title);
    setEditing(true);
  };
  const commitRename = (): void => {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== s.title) void renameSession(s.session_id, title);
  };
  // tab 聚焦时按此锚点定位行（DOM 查询，不用逐层 ref）。
  const rowAttr = { "data-session-row": s.session_id };
  // 导出为 Markdown：优先用内存 blocks，没加载过先拉一次历史。
  const exportSession = async (): Promise<void> => {
    const st = useStore.getState();
    let blocks = st.blocksBySession[s.session_id];
    if (!blocks) {
      try {
        const res = await fetch(`${apiBase(st.serverUrl)}/api/sessions/${s.session_id}/messages`, {
          headers: { Authorization: `Bearer ${st.token}` },
        });
        if (!res.ok) {
          useStore.setState({ error: t("sess.exportFail") });
          return;
        }
        blocks = ((await res.json()) as { blocks: Block[] }).blocks;
      } catch {
        useStore.setState({ error: t("sess.exportFail") });
        return;
      }
    }
    const markdown = blocksToMarkdown(s, blocks);
    const r = await window.blm.exportChat({
      default_filename: `${s.title}.md`,
      markdown,
    });
    if (r.saved && r.path) useStore.setState({ error: t("sess.exported", { path: r.path }) });
    else if (r.error) useStore.setState({ error: r.error });
  };
  return (
    <div
      {...rowAttr}
      className={`session-item ${active ? "active" : ""}`}
      onClick={() => void selectSession(s.session_id)}
      onContextMenu={
        onMoveMenu
          ? (e) => {
              e.preventDefault();
              onMoveMenu(s.session_id, e.clientX, e.clientY);
            }
          : undefined
      }
    >
      {busy && <span className="session-busy-dot" title={t("chat.tabBusyTip")} />}
      {editing ? (
        <input
          autoFocus
          value={draft}
          style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "1px 4px" }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="title">{s.title}</span>
      )}
      {!editing && (
        <button
          className="del"
          title={t("sess.rename")}
          onClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
        >
          ✏️
        </button>
      )}
      {!editing && (
        <button
          className="del"
          title={t("sess.export")}
          onClick={(e) => {
            e.stopPropagation();
            void exportSession();
          }}
        >
          ⬇
        </button>
      )}
      <button
        className="del"
        title={
          s.shared
            ? s.shared_with?.length
              ? t("sess.sharedWith", { names: s.shared_with.join("、") })
              : t("sess.sharedAll")
            : t("sess.share")
        }
        style={s.shared ? { color: "var(--info)" } : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onShare(s.session_id);
        }}
      >
        ❐
      </button>
      <button
        className="del"
        title={t("sess.del")}
        onClick={(e) => {
          e.stopPropagation();
          void deleteSession(s.session_id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

const groupHeaderStyle = {
  margin: "10px 0 2px",
  fontSize: 12,
  color: "var(--muted)",
  padding: "0 8px",
} as const;

// 定时任务紧凑行（项目组内）：名称/下次运行/立即执行/启停/打开会话/删除。
// 整行可点进专属会话（行内按钮 stopPropagation 不抢）。
function ScheduleRow({ rec }: { rec: ScheduleView }): React.JSX.Element {
  const setScheduleEnabled = useStore((s) => s.setScheduleEnabled);
  const deleteSchedule = useStore((s) => s.deleteSchedule);
  const triggerSchedule = useStore((s) => s.triggerSchedule);
  const selectSession = useStore((s) => s.selectSession);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const t = useT();
  const doRemove = (): void => {
    if (window.confirm(t("sc.deleteConfirm", { name: rec.name }))) {
      void deleteSchedule(rec.schedule_id);
    }
  };
  // 选中锚点：定时任务行代表其专属会话（rec.session_id 可能未建）。
  const rowAttr = rec.session_id
    ? { "data-session-row": rec.session_id }
    : {};
  // 立即执行：成功且服务端已建/绑定会话时顺带切过去（方便测试看结果）；
  // 被跳过（不在线/忙）时如实轻提示。
  const runNow = (): void => {
    void triggerSchedule(rec.schedule_id)
      .then((updated) => {
        if (updated.last_result === "skipped") {
          const reason =
            updated.last_skip_reason === "owner_offline"
              ? t("sc.reasonOwnerOffline")
              : updated.last_skip_reason === "session_busy"
                ? t("sc.reasonSessionBusy")
                : t("sc.reasonUserDisabled");
          useStore.setState({ error: t("sc.runSkipped", { reason }) });
          return;
        }
        if (updated.session_id) void selectSession(updated.session_id);
      })
      .catch(() => useStore.setState({ error: t("sc.saveFail") }));
  };
  return (
    <div
      {...rowAttr}
      className={`session-item ${
        rec.session_id && rec.session_id === currentSessionId && !sharedView
          ? "active"
          : ""
      } ${rec.session_id ? "" : "disabled"}`}
      style={{ opacity: rec.enabled ? 1 : 0.55 }}
      title={rec.prompt.length > 80 ? `${rec.prompt.slice(0, 80)}…` : rec.prompt}
      onClick={() => {
        if (rec.session_id) void selectSession(rec.session_id);
      }}
    >
      <span className="title">⏰ {rec.name}</span>
      <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
        {rec.next_run_at
          ? new Date(rec.next_run_at).toLocaleString()
          : t("sc.neverRun")}
      </span>
      <button
        className="del"
        title={t("sc.runNow")}
        onClick={(e) => {
          e.stopPropagation();
          runNow();
        }}
      >
        ⚡
      </button>
      <button
        className="del"
        title={rec.enabled ? t("sc.enabled") : t("sc.neverRun")}
        onClick={(e) => {
          e.stopPropagation();
          void setScheduleEnabled(rec.schedule_id, !rec.enabled);
        }}
      >
        {rec.enabled ? "⏸" : "▶"}
      </button>
      {rec.session_id && (
        <button
          className="del"
          title={t("sc.openSession")}
          onClick={(e) => {
            e.stopPropagation();
            void selectSession(rec.session_id!);
          }}
        >
          →
        </button>
      )}
      <button
        className="del"
        title={t("sc.delete")}
        onClick={(e) => {
          e.stopPropagation();
          doRemove();
        }}
      >
        ✕
      </button>
    </div>
  );
}

// 共享行的小红点（内联组件：list 顶层订阅 busy 会随任何会话
// 的回合结束整表重渲；组件级订阅只重渲变化的那几行）。
function SessionBusyDot({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const busy = useStore((s) => s.busy[sessionId] ?? false);
  const t = useT();
  if (!busy) return null;
  return <span className="session-busy-dot" title={t("chat.tabBusyTip")} />;
}

// 协作任务状态徽标配色（与 UpdateRequestsDialog 的状态色一致风格）。
// active 按当前环节位置给色，让进行中的任务一眼可辨进度深浅。
const TASK_COLOR_ACTIVE = "var(--info)";
const TASK_COLOR_DONE = "var(--ok)";
const TASK_COLOR_CANCELLED = "var(--muted)";

// 协作任务行：标题 + 我的角色角标（需求/我负责的环节名）+ 状态徽标；done
// （含取消）灰显。点击进线程：自己是需求方走本人会话，否则走共享只读视图。
function TaskRow({ task }: { task: TaskView }): React.JSX.Element {
  const me = useStore((s) => s.username);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const busy = useStore((s) => s.busy[task.session_id] ?? false);
  const selectSession = useStore((s) => s.selectSession);
  const selectSharedSession = useStore((s) => s.selectSharedSession);
  const deleteTask = useStore((s) => s.deleteTask);
  const t = useT();
  const roles: string[] = [];
  if (task.requester === me) roles.push(t("task.tagRequester"));
  for (const s of task.stages) {
    if (s.assignee === me) roles.push(s.name);
  }
  const mine = task.requester === me;
  const done = task.status === "done";
  const cur = task.current_stage ? task.stages.find((s) => s.key === task.current_stage) : null;
  const statusColor = done
    ? task.cancelled
      ? TASK_COLOR_CANCELLED
      : TASK_COLOR_DONE
    : TASK_COLOR_ACTIVE;
  const statusLabel = done
    ? task.cancelled
      ? t("task.statusCancelled")
      : t("task.statusDone")
    : (cur?.name ?? t("task.statusActive"));
  const assignees = task.stages
    .filter((s) => s.assignee)
    .map((s) => `${s.name}: ${s.assignee}`)
    .join(" · ");
  const rowAttr = { "data-session-row": task.session_id };
  return (
    <div
      {...rowAttr}
      className={`session-item ${task.session_id === currentSessionId ? "active" : ""}`}
      style={done ? { opacity: 0.55 } : undefined}
      title={`${t("task.roleRequester")}: ${task.requester}${assignees ? ` · ${assignees}` : ""}`}
      onClick={() => void (mine ? selectSession(task.session_id) : selectSharedSession(task.session_id))}
    >
      {busy && <span className="session-busy-dot" title={t("chat.tabBusyTip")} />}
      <span className="title">{task.title}</span>
      {roles.length > 0 && (
        <span
          style={{
            fontSize: 10,
            color: "var(--info)",
            border: "1px solid rgba(74,163,255,.4)",
            borderRadius: 999,
            padding: "0 5px",
            whiteSpace: "nowrap",
          }}
        >
          {roles.join("/")}
        </span>
      )}
      <span style={{ fontSize: 11, color: statusColor, whiteSpace: "nowrap" }}>{statusLabel}</span>
      {/* 已完结任务记录可由需求方删除（含绑定会话已删的幽灵条目）。 */}
      {mine && done && (
        <button
          className="del"
          title={t("task.deleteRecord")}
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(t("task.deleteConfirm", { name: task.title })))
              void deleteTask(task.task_id);
          }}
        >
          ✕
        </button>
      )}
      {!mine && <span className="offline-tip">{task.requester}</span>}
    </div>
  );
}

function ProjectGroup({
  project,
  sessions,
  expanded,
  onToggle,
  onExpand,
  onShare,
  onMoveMenu,
  onSettings,
  onNewTask,
  onNewSchedule,
}: {
  project: ProjectMeta;
  sessions: SessionMeta[];
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onShare: (sessionId: string) => void;
  onMoveMenu?: (sessionId: string, x: number, y: number) => void;
  onSettings: () => void;
  onNewTask: () => void;
  onNewSchedule: () => void;
}): React.JSX.Element {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const newSession = useStore((s) => s.newSession);
  const deleteProject = useStore((s) => s.deleteProject);
  const role = useStore((s) => s.role);
  const schedules = useStore((s) => s.schedules);
  const t = useT();
  const isPublic = project.visibility === "public";
  const kind = project.kind ?? "standard";

  // undefined = not queried yet; null = unbound on this machine.
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (isPublic) return; // 公有域项目没有本机文件夹绑定
    let alive = true;
    void window.blm.getProjectFolder(project.project_id).then((r) => {
      if (alive) setFolder(r.folder);
    });
    return () => {
      alive = false;
    };
  }, [isPublic, project.project_id]);

  const bindFolder = (): void => {
    void window.blm
      .bindProjectFolder(project.project_id, { name: project.name, choose: true })
      .then((r) => {
        if (r.ok) setFolder(r.folder ?? null);
      });
  };

  // 组头图标按类型区分：📁 普通 / 🤝 协作 / ⏰ 定时 / 🌐 公域。
  const kindIcon = isPublic ? "🌐" : kind === "collab" ? "🤝" : kind === "scheduled" ? "⏰" : "📁";
  const delConfirm =
    kind === "scheduled"
      ? t("proj.deleteScheduledConfirm", {
          name: project.name,
          count: schedules.filter((r) => r.project_id === project.project_id).length,
        })
      : isPublic
        ? t("proj.deletePublicConfirm", { name: project.name })
        : t("proj.deleteConfirm", { name: project.name });

  return (
    <>
      <div className="project-group-head" style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", gap: 4 }}>
        {/* 箭头展开/收起：上限与淘汰逻辑由父层统一执行。
            常显（唯一入口，藏进悬停会让收起的组找不到出口）。 */}
        <button
          className="del always"
          title={t("proj.expandTip")}
          onClick={onToggle}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={
            isPublic
              ? t("proj.publicTip", { owner: project.owner ?? "" })
              : folder
                ? t("proj.spaceTip", { folder })
                : t("proj.unboundTip")
          }
        >
          {kindIcon} {project.name}
          {!isPublic && folder === null && (
            <span style={{ color: "var(--warn)" }}>{t("proj.unbound")}</span>
          )}
        </span>
        {!isPublic && (
          <button
            className="del"
            title={folder ? t("proj.rebind") : t("proj.bind")}
            onClick={bindFolder}
          >
            📁
          </button>
        )}
        <button className="del" title={t("proj.settings")} onClick={onSettings}>
          ⚙
        </button>
        {/* 组内 ＋ 按类型分流：协作项目 = 新建任务；定时项目 = 新建定时任务；
            其余 = 新建普通会话。三者都先保证组展开，避免新条目落进折叠组。 */}
        {kind === "collab" ? (
          <button
            className="del"
            title={t("task.newTitle")}
            onClick={() => {
              onExpand();
              onNewTask();
            }}
          >
            ＋
          </button>
        ) : kind === "scheduled" ? (
          <button
            className="del"
            title={t("proj.newSchedule")}
            onClick={() => {
              onExpand();
              onNewSchedule();
            }}
          >
            ＋
          </button>
        ) : (
          <button
            className="del"
            title={t("proj.newSession", { name: project.name })}
            onClick={() => {
              onExpand();
              void newSession(project.agent_id, project.project_id);
            }}
          >
            ＋
          </button>
        )}
        {(role === "admin" || !isPublic) && (
          <button
            className="del"
            title={isPublic ? t("proj.deletePublic") : t("proj.delete")}
            onClick={() => {
              if (window.confirm(delConfirm)) {
                void deleteProject(project.project_id);
              }
            }}
          >
            ✕
          </button>
        )}
      </div>
      {/* 组头图标按类型区分：📁 普通 / 🤝 协作 / ⏰ 定时 / 🌐 公域。 */}
      {/* 组内容器：相对组头缩进（从属层级），四类项目一致。
          定时任务项目再深一层：⏰ 任务行下缩进挂其专属会话（运行
          记录从属于宿主任务），无宿主的会话留在组级。 */}
      {expanded && kind === "scheduled" && (() => {
        const projScheds = schedules.filter(
          (r) => r.project_id === project.project_id,
        );
        const boundIds = new Set(
          projScheds.map((r) => r.session_id).filter((id): id is string => !!id),
        );
        const orphans = sessions.filter(
          (s) => !boundIds.has(s.session_id),
        );
        return (
          <div style={{ paddingLeft: 14 }}>
            {projScheds.map((rec) => (
              <div key={rec.schedule_id}>
                <ScheduleRow rec={rec} />
                {rec.session_id && (
                  <div style={{ paddingLeft: 14 }}>
                    {sessions
                      .filter((s) => s.session_id === rec.session_id)
                      .map((s) => (
                        <SessionRow
                          key={s.session_id}
                          s={s}
                          active={s.session_id === currentSessionId && !sharedView}
                          onShare={onShare}
                          onMoveMenu={onMoveMenu}
                        />
                      ))}
                  </div>
                )}
              </div>
            ))}
            {orphans.map((s) => (
              <SessionRow
                key={s.session_id}
                s={s}
                active={s.session_id === currentSessionId && !sharedView}
                onShare={onShare}
                onMoveMenu={onMoveMenu}
              />
            ))}
          </div>
        );
      })()}
      {expanded && kind !== "scheduled" && (
        <div style={{ paddingLeft: 14 }}>
          {sessions.map((s) => (
            <SessionRow
              key={s.session_id}
              s={s}
              active={s.session_id === currentSessionId && !sharedView}
              onShare={onShare}
              onMoveMenu={onMoveMenu}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function SessionList({
  onShare,
  onNewProject,
}: {
  onShare: (sessionId: string) => void;
  onNewProject: () => void;
}): React.JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const sharedSessions = useStore((s) => s.sharedSessions);
  const tasks = useStore((s) => s.tasks);
  const schedules = useStore((s) => s.schedules);
  const loadSchedules = useStore((s) => s.loadSchedules);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const selectSharedSession = useStore((s) => s.selectSharedSession);
  const presence = useStore((s) => s.presence);
  const moveSession = useStore((s) => s.moveSession);
  const t = useT();

  // 定时任务行数据（⏰）进侧边栏，挂载时播种一次（WS 增量照常）。
  useEffect(() => {
    void loadSchedules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 协作任务分区 + 「＋新任务」弹窗（全局入口 + 协作项目组内入口）。
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskProject, setNewTaskProject] = useState<ProjectMeta | null>(null);
  // 定时任务项目组内「＋新建定时任务」。
  const [newScheduleProject, setNewScheduleProject] = useState<ProjectMeta | null>(null);

  // 项目组展开状态（FIFO 淘汰）：同时最多展开 2 个项目，展开第 3 个
  // 时最早展开的自动收起；搜索时强制全展开（命中会话不能被折叠藏掉）。
  // 会话搜索（标题纯客户端 + 内容走服务端）：命中标题或共享会话的
  // owner 即过滤列表；输入 ≥1 字时同时触发内容全文搜索（300ms 防抖）。
  const [query, setQuery] = useState("");
  const MAX_EXPANDED = 2;
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const searchActive = query.trim() !== "";
  const isExpanded = (id: string): boolean =>
    searchActive || expandedIds.includes(id);
  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-MAX_EXPANDED),
    );
  };
  // 保证展开（不收起已展开的）：组内 ＋ 新建前调用，否则新会话会落进折叠组里看不见。
  const expandOnly = (id: string): void => {
    setExpandedIds((prev) =>
      prev.includes(id) ? prev : [...prev, id].slice(-MAX_EXPANDED),
    );
  };

  // 与头顶 tab 联动：tab 聚焦某会话时，其所在项目组自动展开
  // （折叠组里的选中行等于藏掉了），并把选中行滚进视野。
  // 行定位走 DOM 查询（data-session-row），不给每层组件塞 ref。
  // 从列表点选的会话必然可见，用 lastFollowed 跳过追焦。
  const lastFollowed = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSessionId) return;
    if (lastFollowed.current === currentSessionId) return;
    lastFollowed.current = currentSessionId;
    const projId = sessions.find((s) => s.session_id === currentSessionId)?.project_id;
    if (projId && known.has(projId)) expandOnly(projId);
    // 组展开是异步渲染：下一帧再找行滚动（找不到 = 该会话不在
    // 本人列表里，如内容搜索行，跳过即可）。
    const raf = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-session-row="${currentSessionId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentSessionId, sessions]);

  // Right-click "move to project" menu state (viewport coords).
  const [moveMenu, setMoveMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  // Which project's settings dialog is open (null = none).
  const [settingsFor, setSettingsFor] = useState<ProjectMeta | null>(null);
  const [contentHits, setContentHits] = useState<SessionSearchItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const q = query.trim().toLowerCase();
  const matchSession = (s: SessionMeta): boolean =>
    !q ||
    s.title.toLowerCase().includes(q) ||
    (s.owner ?? "").toLowerCase().includes(q);

  // 内容搜索：防抖 300ms 后请求 /api/sessions/search；请求序号守卫
  // （响应乱序时丢弃旧响应）。标题命中的会话不再进内容结果，去重。
  const searchSeq = useRef(0);
  useEffect(() => {
    const kw = query.trim();
    if (kw.length < 1) {
      setContentHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const st = useStore.getState();
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      fetch(`${apiBase(st.serverUrl)}/api/sessions/search?q=${encodeURIComponent(kw)}`, {
        headers: { Authorization: `Bearer ${st.token}` },
      })
        .then((res) => (res.ok ? (res.json() as Promise<SessionSearchItem[]>) : []))
        .then((items) => {
          if (searchSeq.current !== seq) return; // 旧响应，丢弃
          setContentHits(items);
          setSearching(false);
        })
        .catch(() => {
          if (searchSeq.current !== seq) return;
          setContentHits([]);
          setSearching(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      searchSeq.current++; // 取消在途：效果等同旧响应
      setSearching(false);
    };
  }, [query]);
  // 内容搜索结果里去掉标题命中的会话（避免同一会话出现两行）。
  const contentOnly = (contentHits ?? []).filter(
    (item) => !sessions.some((s) => s.session_id === item.session_id && matchSession(s)),
  );

  // 公有域项目单独分区展示（工作空间在服务端，而非本机文件夹）；
  // 个人项目再按类型分三段（普通/协作/定时）。
  const personalProjects = projects.filter((p) => p.visibility !== "public");
  const standardProjects = personalProjects.filter((p) => (p.kind ?? "standard") === "standard");
  const collabProjects = personalProjects.filter((p) => p.kind === "collab");
  const scheduledProjects = personalProjects.filter((p) => p.kind === "scheduled");
  const publicProjects = projects.filter((p) => p.visibility === "public");

  const byProject = new Map<string, SessionMeta[]>();
  const def: SessionMeta[] = [];
  const known = new Set(projects.map((p) => p.project_id));
  for (const s of sessions) {
    if (!matchSession(s)) continue;
    if (s.project_id && known.has(s.project_id)) {
      const arr = byProject.get(s.project_id) ?? [];
      arr.push(s);
      byProject.set(s.project_id, arr);
    } else {
      def.push(s); // default space, incl. orphaned project ids
    }
  }
  // 只在搜索时隐藏空分组（没有命中会话的项目不显示）；平时新项目 0 个会话也要显示。
  const emptyGroup = (p: ProjectMeta): boolean => (byProject.get(p.project_id) ?? []).length === 0;
  // 定时任务项目即使还没有会话，也要在有定时任务时显示组。
  const hasSchedules = (p: ProjectMeta): boolean =>
    (p.kind ?? "standard") === "scheduled" &&
    schedules.some((r) => r.project_id === p.project_id);
  const groupVisible = (p: ProjectMeta): boolean =>
    !q || !emptyGroup(p) || hasSchedules(p);
  const visiblePersonal = standardProjects.filter(groupVisible);
  const visibleCollab = collabProjects.filter(groupVisible);
  const visibleScheduled = scheduledProjects.filter(groupVisible);
  const visiblePublic = publicProjects.filter(groupVisible);
  // 协作任务：活跃在前、done 灰显（listTasks 已按 updated_at 倒序）。
  const visibleTasks = tasks.filter((task) => !q || task.title.toLowerCase().includes(q));
  const activeTasks = visibleTasks.filter((task) => task.status !== "done");
  const doneTasks = visibleTasks.filter((task) => task.status === "done");
  const taskSessionIds = new Set(tasks.map((task) => task.session_id));
  const visibleShared = sharedSessions
    .filter(matchSession)
    .filter((s) => !taskSessionIds.has(s.session_id));
  const nothingVisible =
    q !== "" &&
    visiblePersonal.length === 0 &&
    visibleCollab.length === 0 &&
    visibleScheduled.length === 0 &&
    visiblePublic.length === 0 &&
    def.length === 0 &&
    visibleShared.length === 0 &&
    visibleTasks.length === 0 &&
    contentOnly.length === 0;

  const menuSession = moveMenu
    ? sessions.find((s) => s.session_id === moveMenu.sessionId)
    : undefined;
  // 移动目标只允许同 visibility（个人↔公域禁止互移，服务端也会拒绝）。
  const menuIsPublic = menuSession?.project_id
    ? projects.find((p) => p.project_id === menuSession.project_id)?.visibility === "public"
    : false;

  return (
    <>
      <input
        value={query}
        placeholder={t("sess.searchPh")}
        style={{ margin: "0 8px 4px", fontSize: 12, padding: "3px 8px", width: "auto" }}
        onChange={(e) => setQuery(e.target.value)}
      />

      {/* New-project entry lives right below the search box. The row-level ＋
          buttons mean "new session in this project" and must not be confused
          with creating a project. */}
      <button
        title={t("proj.newProjectTip")}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: groupHeaderStyle.padding,
          margin: "2px 0 0",
          fontSize: 12,
          color: "var(--muted)",
          background: "none",
          border: "none",
          cursor: "pointer",
        }}
        onClick={onNewProject}
      >
        {t("proj.newProject")}
      </button>

      {/* 项目组相对其所在分区缩进（分区头 → 组头 → 内容三层）。 */}
      <div style={{ paddingLeft: 14 }}>
      {visiblePersonal.map((p) => (
        <ProjectGroup
          key={p.project_id}
          project={p}
          sessions={byProject.get(p.project_id) ?? []}
          expanded={isExpanded(p.project_id)}
          onToggle={() => toggleExpand(p.project_id)}
          onExpand={() => expandOnly(p.project_id)}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          onSettings={() => setSettingsFor(p)}
          onNewTask={() => {
            setNewTaskProject(null);
            setNewTaskOpen(true);
          }}
          onNewSchedule={() => setNewScheduleProject(p)}
        />
      ))}

      {visibleCollab.length > 0 && (
        <div style={groupHeaderStyle}>{t("proj.sectionCollab")}</div>
      )}
      {visibleCollab.map((p) => (
        <ProjectGroup
          key={p.project_id}
          project={p}
          sessions={byProject.get(p.project_id) ?? []}
          expanded={isExpanded(p.project_id)}
          onToggle={() => toggleExpand(p.project_id)}
          onExpand={() => expandOnly(p.project_id)}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          onSettings={() => setSettingsFor(p)}
          onNewTask={() => {
            setNewTaskProject(p);
            setNewTaskOpen(true);
          }}
          onNewSchedule={() => setNewScheduleProject(p)}
        />
      ))}

      {visibleScheduled.length > 0 && (
        <div style={groupHeaderStyle}>{t("proj.sectionScheduled")}</div>
      )}
      {visibleScheduled.map((p) => (
        <ProjectGroup
          key={p.project_id}
          project={p}
          sessions={byProject.get(p.project_id) ?? []}
          expanded={isExpanded(p.project_id)}
          onToggle={() => toggleExpand(p.project_id)}
          onExpand={() => expandOnly(p.project_id)}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          onSettings={() => setSettingsFor(p)}
          onNewTask={() => {
            setNewTaskProject(null);
            setNewTaskOpen(true);
          }}
          onNewSchedule={() => setNewScheduleProject(p)}
        />
      ))}

      {visiblePublic.length > 0 && (
        <div style={groupHeaderStyle}>{t("proj.publicSection")}</div>
      )}
      {visiblePublic.map((p) => (
        <ProjectGroup
          key={p.project_id}
          project={p}
          sessions={byProject.get(p.project_id) ?? []}
          expanded={isExpanded(p.project_id)}
          onToggle={() => toggleExpand(p.project_id)}
          onExpand={() => expandOnly(p.project_id)}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          onSettings={() => setSettingsFor(p)}
          onNewTask={() => {
            setNewTaskProject(null);
            setNewTaskOpen(true);
          }}
          onNewSchedule={() => setNewScheduleProject(p)}
        />
      ))}
      </div>

      {def.length > 0 && <div style={groupHeaderStyle}>{t("sess.defaultSpace")}</div>}
      <div style={{ paddingLeft: 14 }}>
        {def.map((s) => (
          <SessionRow
            key={s.session_id}
            s={s}
            active={s.session_id === currentSessionId && !sharedView}
            onShare={onShare}
            onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          />
        ))}
      </div>

      {/* 协作任务（需求 → 研发 → 测试）：线程入口集中在此；共享分区不再重复展示。 */}
      {(visibleTasks.length > 0 || !q) && (
        <div className="project-group-head" style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", gap: 4, marginTop: 12 }}>
          <span style={{ flex: 1 }}>🧭 {t("task.section")}</span>
          <button
            className="del"
            title={t("task.newTitle")}
            onClick={() => setNewTaskOpen(true)}
          >
            ＋{t("task.newTask")}
          </button>
        </div>
      )}
      <div style={{ paddingLeft: 14 }}>
        {activeTasks.map((task) => (
          <TaskRow key={task.task_id} task={task} />
        ))}
        {doneTasks.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--muted)", padding: "2px 8px" }}>
            {t("task.doneHeader")}
          </div>
        )}
        {doneTasks.map((task) => (
          <TaskRow key={task.task_id} task={task} />
        ))}
      </div>
      {newTaskOpen && (
        <NewTaskDialog
          project={newTaskProject ?? undefined}
          onClose={() => {
            setNewTaskOpen(false);
            setNewTaskProject(null);
          }}
        />
      )}
      {newScheduleProject && (
        <NewScheduleDialog
          project={newScheduleProject}
          onClose={() => setNewScheduleProject(null)}
        />
      )}

      {/* 会话内容搜索结果（含只命中内容、标题未中的会话）。 */}
      {q !== "" && contentOnly.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", padding: "0 8px" }}>
          {t("sess.contentHeader")}
        </div>
      )}
      {contentOnly.map((item) => (
        <SearchHitRow key={item.session_id} item={item} q={q} />
      ))}
      {q !== "" && searching && contentOnly.length === 0 && (
        <div style={{ margin: "6px 8px", fontSize: 12, color: "var(--muted)" }}>
          {t("sess.searching")}
        </div>
      )}

      {nothingVisible && !searching && (
        <div style={{ margin: "6px 8px", fontSize: 12, color: "var(--muted)" }}>
          {contentHits !== null && t("sess.noContent") || t("sess.noMatch")}
        </div>
      )}

      {visibleShared.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", padding: "0 8px" }}>
          {t("sess.sharedHeader")}
        </div>
      )}
      <div style={{ paddingLeft: 14 }}>
        {visibleShared.map((s) => {
          const online = s.owner ? (presence[s.owner] ?? s.owner_online ?? false) : false;
          return (
            <div
              key={s.session_id}
              data-session-row={s.session_id}
              className={`session-item ${s.session_id === currentSessionId && sharedView ? "active" : ""}`}
              title={t("sess.viewTip", { owner: s.owner ?? "", online: online ? t("chat.ownerOnline") : t("chat.ownerOffline") })}
              onClick={() => void selectSharedSession(s.session_id)}
            >
              <SessionBusyDot sessionId={s.session_id} />
              <span className="title">
                {s.owner} / {s.title}
              </span>
              <span
                className={`status-dot ${online ? "ok" : "bad"}`}
                title={online ? t("chat.ownerOnline") : t("chat.ownerOffline")}
              />
              {!online && <span className="offline-tip">{t("sess.offline")}</span>}
            </div>
          );
        })}
      </div>

      {/* Right-click menu: move one of my sessions into another project (or
          back to the default space). Click-anywhere overlay closes it. */}
      {settingsFor && (
        <ProjectSettingsDialog project={settingsFor} onClose={() => setSettingsFor(null)} />
      )}

      {moveMenu && menuSession && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1000 }}
          onClick={() => setMoveMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMoveMenu(null);
          }}
        >
          <div
            style={{
              position: "fixed",
              left: Math.min(moveMenu.x, window.innerWidth - 190),
              top: Math.min(moveMenu.y, window.innerHeight - 240),
              minWidth: 170,
              maxHeight: 220,
              overflowY: "auto",
              background: "var(--panel, #fff)",
              border: "1px solid var(--border, #ddd)",
              borderRadius: 8,
              boxShadow: "0 4px 16px rgba(0,0,0,.18)",
              padding: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 8px" }}>
              {t("move.title", {
                title:
                  menuSession.title.length > 12
                    ? `${menuSession.title.slice(0, 12)}…`
                    : menuSession.title,
              })}
            </div>
            {projects
              .filter((p) => (p.visibility === "public") === menuIsPublic)
              .filter((p) => p.project_id !== (menuSession.project_id ?? null))
              .map((p) => (
                <button
                  key={p.project_id}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    fontSize: 12,
                    padding: "5px 8px",
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    void moveSession(menuSession.session_id, p.project_id);
                    setMoveMenu(null);
                  }}
                >
                  📁 {p.name}
                </button>
              ))}
            {menuSession.project_id && !menuIsPublic && (
              <button
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  fontSize: 12,
                  padding: "5px 8px",
                  background: "none",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                }}
                onClick={() => {
                  void moveSession(menuSession.session_id, null);
                  setMoveMenu(null);
                }}
              >
                {t("move.default")}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
