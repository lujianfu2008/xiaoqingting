import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { WorkflowInfo, WorkflowStage } from "@blm/protocol";
import { BUILT_IN_WORKFLOW_NAME, UpsertWorkflowRequest, WorkflowName } from "@blm/protocol";
import { config } from "./config.js";

// 工作流模板配置：内置（运行时常量，不落盘）+ 全局（data/workflow-templates.json，
// 管理员维护、可直接手改）+ 用户级（data/workflow-users.json，REST 管理）。
// 与 mcpConfig.ts 同构：模板名即主键，两层级共用命名空间；合并优先级
// 内置 < 全局 < 用户（同名时用户模板整体覆盖）。模板只有环节序列与预置负责人，
// 无敏感字段，文件不加 0600。

// 内置默认模板（即旧版写死的 需求→研发→测试 流程）。禁删禁改由构造保证：
// 它不在任何文件里，手改/删文件都伤不到；迁移映射（taskManager.migrateLegacyTasks）
// 依赖这里的环节 key，改 key 等于改存储格式。
export const BUILT_IN_WORKFLOW: {
  name: string;
  description: string;
  stages: WorkflowStage[];
} = {
  name: BUILT_IN_WORKFLOW_NAME,
  description: "需求分析 → 研发 → 测试",
  stages: [
    { key: "requirement", name: "需求分析" },
    { key: "dev", name: "研发" },
    { key: "test", name: "测试" },
  ],
};

// 与内置模板同名会破坏迁移映射与「不可删改」语义，禁止用户/全局占用。
export const RESERVED_WORKFLOW_NAMES = new Set([BUILT_IN_WORKFLOW.name]);

export interface StoredTemplate {
  description?: string;
  stages: WorkflowStage[];
  updated_at: string;
}

const StoredTemplateShape = UpsertWorkflowRequest.extend({
  updated_at: z.string().optional(),
});

function globalFile(): string {
  return path.join(config.dataDir, "workflow-templates.json");
}

function userFile(): string {
  return path.join(config.dataDir, "workflow-users.json");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 手改文件里结构非法的条目静默丢弃（不出现在列表、不进建任务解析），与
// mcpConfig normalizeMap 行为一致。
function normalizeTemplate(raw: unknown): StoredTemplate | null {
  const parsed = StoredTemplateShape.safeParse(raw);
  return parsed.success
    ? {
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        stages: parsed.data.stages,
        updated_at: parsed.data.updated_at ?? new Date(0).toISOString(),
      }
    : null;
}

function normalizeMap(raw: unknown): Record<string, StoredTemplate> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, StoredTemplate> = {};
  for (const [name, tpl] of Object.entries(raw as Record<string, unknown>)) {
    if (!WorkflowName.safeParse(name).success) continue;
    if (RESERVED_WORKFLOW_NAMES.has(name)) continue;
    const normalized = normalizeTemplate(tpl);
    if (normalized) out[name] = normalized;
  }
  return out;
}

function toInfo(
  name: string,
  tpl: StoredTemplate,
  source: WorkflowInfo["source"],
  overridesGlobal: boolean,
): WorkflowInfo {
  return {
    name,
    ...(tpl.description ? { description: tpl.description } : {}),
    stages: tpl.stages,
    source,
    overrides_global: overridesGlobal || undefined,
    updated_at: tpl.updated_at,
  };
}

// ---------- 全局层 ----------

export function loadGlobalTemplates(): Record<string, StoredTemplate> {
  const parsed = readJson(globalFile()) as { workflows?: unknown } | null;
  return normalizeMap(parsed?.workflows);
}

export function saveGlobalTemplates(map: Record<string, StoredTemplate>): void {
  fs.mkdirSync(path.dirname(globalFile()), { recursive: true });
  fs.writeFileSync(globalFile(), JSON.stringify({ workflows: map }, null, 2));
}

export function deleteGlobalTemplate(name: string): boolean {
  const map = loadGlobalTemplates();
  if (!(name in map)) return false;
  delete map[name];
  saveGlobalTemplates(map);
  return true;
}

// ---------- 用户层 ----------

interface StoredUserWorkflows {
  workflows: Record<string, StoredTemplate>;
  updated_at: string;
}

function loadUserAll(): Record<string, StoredUserWorkflows> {
  const parsed = readJson(userFile());
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, StoredUserWorkflows>)
    : {};
}

function saveUserAll(all: Record<string, StoredUserWorkflows>): void {
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(userFile(), JSON.stringify(all, null, 2));
}

export function getUserTemplates(username: string): Record<string, StoredTemplate> {
  return normalizeMap(loadUserAll()[username]?.workflows);
}

export function setUserTemplate(
  username: string,
  name: string,
  body: { description?: string; stages: WorkflowStage[] },
): WorkflowInfo {
  const all = loadUserAll();
  const mine = all[username]?.workflows ?? {};
  const tpl: StoredTemplate = {
    ...(body.description ? { description: body.description } : {}),
    stages: body.stages,
    updated_at: new Date().toISOString(),
  };
  all[username] = { workflows: { ...mine, [name]: tpl }, updated_at: new Date().toISOString() };
  saveUserAll(all);
  return toInfo(name, tpl, "user", name in loadGlobalTemplates());
}

export function deleteUserTemplate(username: string, name: string): boolean {
  const all = loadUserAll();
  const mine = all[username]?.workflows;
  if (!mine || !(name in mine)) return false;
  delete mine[name];
  all[username] = { workflows: mine, updated_at: new Date().toISOString() };
  saveUserAll(all);
  return true;
}

// ---------- 合并视图与解析 ----------

export interface MergedWorkflows {
  workflows: WorkflowInfo[];
  /** 被用户同名模板覆盖的全局模板名。 */
  overrides: Set<string>;
}

/** 内置 + 全局 + 用户合并后的有效视图（同名用户覆盖全局；内置恒在首位）。 */
export function mergeWorkflows(username: string): MergedWorkflows {
  const global = loadGlobalTemplates();
  const mine = getUserTemplates(username);
  const overrides = new Set<string>();
  const workflows: WorkflowInfo[] = [toInfo(BUILT_IN_WORKFLOW.name, { ...BUILT_IN_WORKFLOW, updated_at: new Date(0).toISOString() }, "built_in", false)];
  for (const [name, tpl] of Object.entries(global)) {
    if (name in mine) {
      overrides.add(name);
      workflows.push(toInfo(name, mine[name], "user", true));
    } else {
      workflows.push(toInfo(name, tpl, "global", false));
    }
  }
  for (const [name, tpl] of Object.entries(mine)) {
    if (!(name in global)) workflows.push(toInfo(name, tpl, "user", false));
  }
  return { workflows, overrides };
}

/**
 * 建任务按名解析模板（含内置；查无返回 null）。只读合并，不做用户校验——
 * 预置岗位原样带出，显式指派的校验在 taskManager。
 */
export function resolveTemplate(
  username: string,
  name?: string,
): { name: string; stages: WorkflowStage[] } | null {
  const want = name?.trim() || BUILT_IN_WORKFLOW.name;
  if (want === BUILT_IN_WORKFLOW.name) return BUILT_IN_WORKFLOW;
  const tpl = getUserTemplates(username)[want] ?? loadGlobalTemplates()[want];
  return tpl ? { name: want, stages: tpl.stages } : null;
}
