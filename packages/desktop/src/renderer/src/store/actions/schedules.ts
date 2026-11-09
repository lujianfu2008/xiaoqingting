import type {
  CreateScheduleRequest,
  ScheduleView,
  SchedulesResponse,
  UpdateScheduleRequest,
} from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

// 定时任务管理。与 actions/workflows.ts 同构：服务端错误码映射为已翻译文案
// 后抛出，由设置面板展示。

function errorText(code: string): string {
  switch (code) {
    case "invalid_request":
      return t("sc.errForm");
    case "invalid_agent":
      return t("sc.errAgent");
    case "name_taken":
      return t("sc.errNameTaken");
    case "not_found":
      return t("sc.errNotFound");
    default:
      return t("sc.saveFail");
  }
}

async function request(
  serverUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${apiBase(serverUrl)}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token ?? ""}`,
    },
  });
  if (!res.ok) {
    let code = "";
    try {
      code = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // non-JSON error body — fall through to generic text
    }
    throw new Error(errorText(code));
  }
  return res.status === 204 ? null : res.json();
}

/** Upsert one schedule（REST 播种与 WS schedule_update 共用，幂等）。 */
export function upsertSchedule(schedule: ScheduleView, set: SetState): void {
  set((s) => {
    const exists = s.schedules.some((x) => x.schedule_id === schedule.schedule_id);
    return {
      schedules: exists
        ? s.schedules.map((x) => (x.schedule_id === schedule.schedule_id ? schedule : x))
        : [schedule, ...s.schedules],
    };
  });
}

export function createScheduleActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "loadSchedules"
  | "createSchedule"
  | "updateSchedule"
  | "setScheduleEnabled"
  | "triggerSchedule"
  | "deleteSchedule"
> {
  return {
    async loadSchedules() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const body = (await request(serverUrl, token, "/api/schedules")) as SchedulesResponse;
        set({ schedules: body.schedules });
      } catch {
        // offline — keep the last known list
      }
    },

    async createSchedule(input) {
      const { serverUrl, token } = get();
      const rec = (await request(serverUrl, token, "/api/schedules", {
        method: "POST",
        body: JSON.stringify(input),
      })) as ScheduleView;
      upsertSchedule(rec, set);
      return rec;
    },

    async updateSchedule(id, input) {
      const { serverUrl, token } = get();
      const rec = (await request(serverUrl, token, `/api/schedules/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
      })) as ScheduleView;
      upsertSchedule(rec, set);
    },

    async setScheduleEnabled(id, enabled) {
      const { serverUrl, token } = get();
      const rec = (await request(
        serverUrl,
        token,
        `/api/schedules/${encodeURIComponent(id)}/enabled`,
        {
          method: "POST",
          body: JSON.stringify({ enabled }),
        },
      )) as ScheduleView;
      upsertSchedule(rec, set);
    },

    /** 立即执行一轮；返回最新记录（被跳过时 last_skip_reason 有值，由面板提示）。 */
    async triggerSchedule(id) {
      const { serverUrl, token } = get();
      const rec = (await request(
        serverUrl,
        token,
        `/api/schedules/${encodeURIComponent(id)}/trigger`,
        { method: "POST" },
      )) as ScheduleView;
      upsertSchedule(rec, set);
      return rec;
    },

    async deleteSchedule(id) {
      const { serverUrl, token } = get();
      await request(serverUrl, token, `/api/schedules/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      set((s) => ({ schedules: s.schedules.filter((x) => x.schedule_id !== id) }));
    },
  };
}
