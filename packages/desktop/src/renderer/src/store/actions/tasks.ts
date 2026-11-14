import type { CreateTaskRequest, FlowAction, TaskView } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

/** Upsert one task（REST 播种与 WS task_update 共用，幂等）。 */
export function upsertTask(task: TaskView, set: SetState): void {
  set((s) => {
    const exists = s.tasks.some((x) => x.task_id === task.task_id);
    return {
      tasks: exists
        ? s.tasks.map((x) => (x.task_id === task.task_id ? task : x))
        : [task, ...s.tasks],
    };
  });
}

export function createTaskActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "loadTasks" | "createTask" | "flowTask" | "deleteTask"> {
  return {
    async loadTasks() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/tasks`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { tasks: TaskView[] };
        set({ tasks: data.tasks });
      } catch {
        // offline — keep the last list
      }
    },

    async deleteTask(taskId) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/tasks/${taskId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          set({ error: body.message ?? t("task.deleteFail") });
          return;
        }
        set((s) => ({ tasks: s.tasks.filter((x) => x.task_id !== taskId) }));
      } catch {
        set({ error: t("task.deleteFail") });
      }
    },

    async createTask(input) {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      });
      if (!res.ok) return null;
      const task = (await res.json()) as TaskView;
      upsertTask(task, set);
      return task;
    },

    async flowTask(taskId, action, opts) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/tasks/${taskId}/flow`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action,
            ...(opts?.target ? { target: opts.target } : {}),
            ...(opts?.stageKey ? { stage_key: opts.stageKey } : {}),
            ...(opts?.note ? { note: opts.note } : {}),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          set({ error: body.message ?? t("task.flowFail") });
          return false;
        }
        upsertTask((await res.json()) as TaskView, set);
        return true;
      } catch {
        set({ error: t("task.flowFail") });
        return false;
      }
    },
  };
}
