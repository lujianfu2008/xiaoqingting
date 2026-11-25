// 级联删除用户账号的单元测试：在隔离的 DATA_DIR 里造数据，跑 deleteUserAfterGuard，
// 断言各类用户级数据被清干净（无孤儿记录）。用法：
//   npx tsx scripts/test-user-delete.ts
// 任一断言失败退出码非 0（软件生产无小事，改删除逻辑必须能复跑本测试）。
//
// 注意：本测试 import 服务端模块，config 在模块顶层读 DATA_DIR——必须在本文件
// 顶层、import 任何服务端模块之前设置 DATA_DIR。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "user-delete-"));
process.env.DATA_DIR = tmpRoot;

const { Store } = await import("../packages/server/src/store.js");
const { AgentManager } = await import("../packages/server/src/agent/AgentManager.js");
const { addUser, listUsers, getUserRecord } = await import("../packages/server/src/users.js");
const { saveSchedule, loadAll } = await import("../packages/server/src/scheduleStore.js");
const { ensureDataDirs } = await import("../packages/server/src/config.js");
const { getUserServers, setUserServer } = await import("../packages/server/src/mcpConfig.js");
const { getEnabledLlmProfiles, upsertLlmProfile } = await import("../packages/server/src/llmConfig.js");
const { getUserTemplates, setUserTemplate } = await import("../packages/server/src/workflowConfig.js");
const { listUserSkills, installSkillMarkdown } = await import("../packages/server/src/skillsConfig.js");
const { getRelayOptIn, setRelayOptIn } = await import("../packages/server/src/relay/relayConfig.js");
const { setPublicExecAuthorized } = await import("../packages/server/src/publicExecAuth.js");
const { listDiagEntries, storeDiagResult } = await import("../packages/server/src/diagStore.js");

ensureDataDirs();
const store = new Store();
const manager = new AgentManager(store);// ---------- 造数据：victim 用户拥有各类数据 ----------
const VICTIM = "victim-e2e";
const OTHER = "other-e2e";
assert.ok(addUser(VICTIM, "pw123456"), "victim 创建失败");
assert.ok(addUser(OTHER, "pw123456"), "other 创建失败");

// 会话：victim 自己一个、OTHER 一个（相互无关）。
const s1 = store.createSession(VICTIM, "assistant", "v1", null);
const s2s = store.createSession(OTHER, "assistant", "o1", null);
// OTHER 的会话把 victim 加进 shared_with（删除时要摘除）。
const s2 = store.getSession(s2s.session_id)!;
s2.shared = true;
s2.shared_with = [VICTIM, "someone-else"];
store.saveSession(s2);
// OTHER 的另一条会话只把 victim 一个列为可见 → 删除后应整条取消共享。
const s3s = store.createSession(OTHER, "assistant", "o2", null);
const s3 = store.getSession(s3s.session_id)!;
s3.shared = true;
s3.shared_with = [VICTIM];
s3.approvers = [VICTIM];
store.saveSession(s3);

// 共享附件目录（按 session id）也应清掉。
fs.mkdirSync(path.join(tmpRoot, "attachments", s1.session_id), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "attachments", s1.session_id, "a.png"), "x");

// 项目：victim 一个个人项目 + 一个公域项目。公域项目目录应清。
const p1 = store.createProject(VICTIM, { name: "victim-personal", agentId: "assistant", visibility: "personal" });
const p2 = store.createProject(VICTIM, { name: "victim-public", agentId: "assistant", visibility: "public" });
fs.mkdirSync(path.join(tmpRoot, "public-projects", p2.project_id), { recursive: true });

// 定时任务（victim 的，disabled——不挡删除，但仍应被级联删掉）。
saveSchedule({
  schedule_id: "sch-1",
  owner: VICTIM,
  name: "每日汇报",
  prompt: "汇报",
  agent_id: "assistant",
  time: { kind: "daily", time: "09:00" },
  enabled: false,
  session_id: null,
  project_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  next_run_at: null,
  last_run_at: null,
  last_result: null,
  last_skip_reason: null,
  missed_count: 0,
  run_count: 0,
});

// 用户级配置：LLM 多配置 / MCP / 工作流 / 技能 / 中继 / 公域授权 / 诊断。
upsertLlmProfile(VICTIM, { name: "cfg1", base_url: "http://x", model: "m", api_key: "k" });
setUserServer(VICTIM, "svr1", { type: "http", url: "http://127.0.0.1:1", enabled: true });
setUserTemplate(VICTIM, "tpl1", { stages: [{ key: "a", name: "A" }] });
installSkillMarkdown(
  "user",
  VICTIM,
  "skillY",
  "---\nname: skillY\ndescription: d\n---\n\n# SkillY\n\nbody",
);
setRelayOptIn(VICTIM, true);
setPublicExecAuthorized(VICTIM, true);
storeDiagResult(VICTIM, {
  request_id: "d123",
  layout: {
    at: new Date().toISOString(),
    app_version: "test",
    viewport: { w: 0, h: 0, dpr: 1 },
    panes: { sidebar: 0, chat: 0, viewer: 0, browser: 0 },
    browser_view: { open: false, bounds: null, view_posed: false },
    browser_pane_rect: null,
  },
});

// ---- 在线协作者收 session_unshared 的断言 ----
// victim 建一条会话并共享给 COLLAB，COLLAB 在线挂着 WS 连接；级联删除后应收到
// session_unshared（在线协作端据此摘除 tab）。
const COLLAB = "collab-e2e";
assert.ok(addUser(COLLAB, "pw123456"), "collab 创建失败");
const sharedSess = store.createSession(VICTIM, "assistant", "victim-shared", null);
const sharedRec = store.getSession(sharedSess.session_id)!;
sharedRec.shared = true;
sharedRec.shared_with = [COLLAB];
store.saveSession(sharedRec);
const collabMsgs: string[] = [];
const unreg = manager.registerConnection(COLLAB, (m) => {
  collabMsgs.push((m as { type?: string }).type ?? "?");
});

console.log("数据造齐，执行级联删除……");
// storeDiagResult 是异步落盘，测试要确定性——先断言它真的写进去了，
// 再同步等写完，然后才删（否则"已清空"是空转断言）。
const diagBefore = listDiagEntries().filter((e) => e.username === VICTIM).length;
await new Promise((r) => setTimeout(r, 100));
const diagAfterWait = listDiagEntries().filter((e) => e.username === VICTIM).length;
assert.ok(diagBefore >= 0 && diagAfterWait > 0, `诊断存档应在删除前存在（before=${diagBefore}, after=${diagAfterWait}）`);
manager.deleteUserAfterGuard(VICTIM);

// ---- 在线协作者收到 session_unshared（victim 共享会话被删） ----
assert.equal(
  collabMsgs.includes("session_unshared"),
  true,
  `在线协作者应收到 session_unshared（实际收到: ${JSON.stringify(collabMsgs)}）`,
);
assert.equal(
  collabMsgs.includes("account_deleted"),
  false,
  "协作者不应收到 victim 的 account_deleted（只发给 victim 本人连接）",
);
unreg();

// ---------- 断言：全量清理无孤儿 ----------
console.log("会话与共享附件");
assert.equal(store.listSessions(VICTIM).length, 0, "victim 的会话应清空");
assert.equal(store.listAllSessions().length, 2, "OTHER 的会话（o1/o2）应保留");

// 附件目录清了没（victim 的会话 id 目录应该没了）。
assert.equal(
  fs.existsSync(path.join(tmpRoot, "attachments", s1.session_id)),
  false,
  "victim 会话附件目录应删除",
);

// shared_with 摘除 victim 但保留别人。
const otherRec = store.getSession(s2.session_id)!;
assert.equal(otherRec.shared_with?.includes(VICTIM), false, "victim 应从 shared_with 摘除");
assert.equal(otherRec.shared_with?.includes("someone-else"), true, "其他人的共享引用应保留");
assert.equal(otherRec.shared, true, "仍有其他可见者 → 保持共享");

// 唯一可见者就是 victim 的会话 → 整条取消共享。
const s3Rec = store.getSession(s3.session_id)!;
assert.equal(s3Rec.shared, false, "唯一可见者被删 → 整条取消共享");
assert.equal(s3Rec.shared_with, undefined, "shared_with 应清空");
assert.equal(s3Rec.approvers, undefined, "approvers 应清空");

console.log("项目");
assert.equal(store.getProject(p1.project_id), null, "个人项目应删除");
assert.equal(store.getProject(p2.project_id), null, "公域项目应删除");
assert.equal(store.listAllProjects().length, 0, "victim 的项目应全删");

console.log("定时任务");
assert.equal(Object.keys(loadAll()).length, 0, "victim 的定时任务应清空");

console.log("LLM / MCP / 工作流 / 技能 / 中继 / 公域授权 / 诊断");
assert.equal(getEnabledLlmProfiles(VICTIM).length, 0, "LLM 配置应清空");
assert.deepEqual(getUserServers(VICTIM), {}, "MCP 配置应清空");
assert.deepEqual(getUserTemplates(VICTIM), {}, "工作流模板应清空");
assert.equal(listUserSkills(VICTIM).length, 0, "用户级技能应清空");
assert.equal(getRelayOptIn(VICTIM), false, "中继 opt-in 应清空");
assert.equal(listDiagEntries().filter((e) => e.username === VICTIM).length, 0, "诊断存档应清空");

// OTHER 的数据不受影响。
assert.equal(store.listSessions(OTHER).length, 2, "OTHER 会话应保留");
assert.equal(getUserServers(OTHER).length ?? 0, 0, "OTHER 无 MCP 配置（不受影响）");

console.log("账号本体的移除（路由层负责）；本测试只验证数据面已清空：" + `（VICTIM=${VICTIM}）`);

console.log("\n--------- 挡板（userDeletionBlocked）负向测试 ----------");
const BLOCKED = "blocked-user";
assert.ok(addUser(BLOCKED, "pw123456"), "blocked 用户创建失败");

// enabled 定时任务 → 挡板。
saveSchedule({
  schedule_id: "sch-blk",
  owner: BLOCKED,
  name: "活跃定时",
  prompt: "跑",
  agent_id: "assistant",
  time: { kind: "daily", time: "10:00" },
  enabled: true,
  session_id: null,
  project_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  next_run_at: new Date().toISOString(),
  last_run_at: null,
  last_result: null,
  last_skip_reason: null,
  missed_count: 0,
  run_count: 0,
});
assert.equal(manager.userDeletionBlocked(BLOCKED), true, "enabled 定时任务应挡删除");
// 取消该用户全部定时任务后不再挡。
{
  const { deleteSchedule } = await import("../packages/server/src/scheduleStore.js");
  const { loadAll: reloadSched } = await import("../packages/server/src/scheduleStore.js");
  for (const r of Object.values(reloadSched())) {
    if (r.owner === BLOCKED) assert.ok(deleteSchedule(BLOCKED, r.schedule_id), "deleteSchedule 应成功");
  }
}
assert.equal(manager.userDeletionBlocked(BLOCKED), false, "定时任务清掉后不再挡");

// 在途协作任务（requester=BLOCKED）→ 挡板。
store.saveTask({
  task_id: "task-blk",
  title: "在途任务",
  status: "active",
  session_id: "unused-session",
  requester: BLOCKED,
  template_name: "standard-flow",
  stages: [{ key: "dev", name: "开发" }],
  current_stage: "dev",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});
assert.equal(manager.userDeletionBlocked(BLOCKED), true, "在途任务（本人需求方）应挡删除");

// done 任务不应挡。
const done = store.getTask("task-blk")!;
done.status = "done";
done.current_stage = null;
store.saveTask(done);
assert.equal(manager.userDeletionBlocked(BLOCKED), false, "完结任务不应挡删除");

// blocked 用户其它数据面仍可被级联删除。
manager.deleteUserAfterGuard(BLOCKED);
assert.equal(store.listAllSessions().filter((s) => s.user_id === BLOCKED).length, 0, "blocked 用户会话应清空");
assert.equal(Object.values(loadAll()).filter((r) => r.owner === BLOCKED).length, 0, "blocked 用户定时任务应清空");
assert.equal(store.getTask("task-blk"), null, "blocked 用户的任务应删除");
console.log("--------- 挡板负向测试通过 ----------");

console.log("\n--------- 审计 / 诊断独立删除 ----------");
{
  const { readRecentAudit: readA, deleteAuditEntry: delA, clearAudit: clrA } =
    await import("../packages/server/src/audit.js");
  const { deleteDiagEntry: delD, listDiagEntries: listD, storeDiagResult: storeD } =
    await import("../packages/server/src/diagStore.js");

  // 审计单条删除：直接写三条同毫秒 ts 的条目（绕过 appendAudit 的内部时间戳，
  // 保证同 ms 碰撞场景可复现），再按三元组精确删除。
  const SAME_TS = "2026-05-05T05:05:05.000Z";
  fs.writeFileSync(
    path.join(tmpRoot, "audit.jsonl"),
    [
      JSON.stringify({ ts: SAME_TS, actor: "audit-t", action: "user.kick", target: "x" }),
      JSON.stringify({ ts: SAME_TS, actor: "audit-t", action: "user.disable", target: "y" }),
      JSON.stringify({ ts: SAME_TS, actor: "audit-t", action: "user.enable", target: "z" }),
      JSON.stringify({ ts: "2026-05-05T00:00:00.000Z", actor: "other", action: "user.kick", target: "w" }),
    ].join("\n") + "\n",
  );

  const entries = readA(10);
  const kickA = entries.find((e) => e.action === "user.kick" && e.target === "x")!;
  console.log("audit entries before delete:", entries.map((e) => `${e.action}@${e.ts}/${e.target}`));
  // 删 kick(x)：同毫秒下其它条目（disable/enable 同 ts，另一条 kick 不同 ts）都应保留。
  assert.equal(
    delA({ ts: kickA.ts, actor: kickA.actor, action: kickA.action }),
    true,
    "单条删除应命中",
  );
  const afterDel = readA(10);
  assert.equal(
    afterDel.some((e) => e.ts === SAME_TS && e.action === "user.kick" && e.target === "x"),
    false,
    "目标条目应消失",
  );
  assert.equal(afterDel.length, 3, "应剩 3 条");
  // 同毫秒的兄弟条目按其实目标保留。
  assert.equal(afterDel.filter((e) => e.ts === SAME_TS).length, 2, "同 ms 的两条兄弟仍在");
  assert.equal(afterDel.some((e) => e.action === "user.disable" && e.target === "y"), true, "同 ms sibling 保留");
  // 未命中删除返回 false。
  assert.equal(
    delA({ ts: "1900-01-01T00:00:00.000Z", actor: "nobody", action: "user.kick" }),
    false,
    "未命中删除应返回 false",
  );

  // 清空。
  const n = clrA();
  assert.equal(n, 3, "清空应返回剩余 3 条");
  assert.equal(readA(10).length, 0, "清空后应为 0");
  console.log("审计单条删除 + 清空 OK");

  // 诊断单条删除：再造一条 diag entry，读回删除。
  // diag id 用真实 nextDiagId 生成的格式；手动写一个。
  fs.mkdirSync(path.join(tmpRoot, "diag"), { recursive: true });
  const layout = {
    at: new Date().toISOString(),
    app_version: "t",
    viewport: { w: 0, h: 0, dpr: 1 },
    panes: { sidebar: 0, chat: 0, viewer: 0, browser: 0 },
    browser_view: { open: false, bounds: null, view_posed: false },
    browser_pane_rect: null,
  };
  storeD("diag-owner", { request_id: "dzz9", layout });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(listD().some((e) => e.id === "dzz9"), "诊断条目应已落盘");
  assert.equal(delD("dzz9"), true, "诊断单条删除应命中");
  assert.equal(listD().some((e) => e.id === "dzz9"), false, "删除后应消失");
  assert.equal(delD("nonexistent"), false, "不存在 id 返回 false");
  console.log("诊断单条删除 OK");
}

console.log("\n✅ ALL CASCADE CHECKS PASSED");
