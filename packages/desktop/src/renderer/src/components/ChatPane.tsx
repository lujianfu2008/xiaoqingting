import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { executorOfTask } from "../store/types";
import { LS } from "../store/persist";
import { ChatMessages } from "./chat/ChatMessages";
import { FlowBar } from "./chat/FlowBar";
import { useVoiceInput } from "./chat/useVoiceInput";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";
import { Splitter } from "./Splitter";

// Module-level stable references: zustand selectors must not return fresh
// object/array literals per call, or useSyncExternalStore loops (React #185).
const EMPTY_BLOCKS: never[] = [];
const INPUT_H_DEFAULT = 76;
const INPUT_H_MIN = 64;
const INPUT_H_MAX = 400;
const CHAT_FS_DEFAULT = 14;
const CHAT_FS_MIN = 11;
const CHAT_FS_MAX = 24;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const loadNum = (key: string, fallback: number): number => {
const n = Number(localStorage.getItem(key));
return Number.isFinite(n) && n > 0 ? n : fallback;
};

// One attachment waiting to be sent with the next message.
interface AttachmentItem {
name: string;
path: string; // absolute path on this machine
dataUrl?: string; // small thumbnail for image chips
}

export function ChatPane(props: { chrome?: PaneChrome }): React.JSX.Element {
const currentSessionId = useStore((s) => s.currentSessionId);
// 当前会话绑定的协作流任务（普通会话为 undefined，流程条不渲染）。
const task = useStore((s) =>
s.currentSessionId ? s.tasks.find((x) => x.session_id === s.currentSessionId) : undefined,
);
const sharedView = useStore((s) => s.sharedView);
const sharedOwner = useStore(
(s) => s.sharedSessions.find((x) => x.session_id === s.currentSessionId)?.owner ?? null,
);
// Own sessions are always "online"; shared ones follow the owner's presence.
// 协作流任务线程跟随当前负责人（工作台跟随指派）。
const ownerOnline = useStore((s) => {
if (!s.sharedView || !s.currentSessionId) return true;
const flowTask = s.tasks.find((x) => x.session_id === s.currentSessionId);
const target = flowTask
? executorOfTask(flowTask)
: s.sharedSessions.find((x) => x.session_id === s.currentSessionId)?.owner;
if (!target) return true;
return s.presence[target] ?? false;
});
const blocks = useStore(
(s) => (currentSessionId ? s.blocksBySession[currentSessionId] : null) ?? EMPTY_BLOCKS,
);
const streamingText = useStore((s) =>
currentSessionId ? (s.streaming[currentSessionId] ?? "") : "",
);
const busy = useStore((s) => (currentSessionId ? (s.busy[currentSessionId] ?? false) : false));
const lastUsage = useStore((s) =>
currentSessionId ? s.usageBySession[currentSessionId] : undefined,
);
const totalUsage = useStore(
(s) => s.sessions.find((x) => x.session_id === s.currentSessionId)?.usage,
);
// 未闭合的主线程委派调用数 = 后台子代理仍在跑。委派 tool_result 闭合该调用，
// 但后台占位结果（任务仍在跑）不算闭合——按内容识别跳过。
const subagentsRunning = useMemo(() => {
const open = new Set<string>();
for (const b of blocks) {
if (b.kind === "tool_call" && b.tool_name === "delegate_task" && !b.parent_tool_call_id) {
open.add(b.id);
} else if (b.kind === "tool_result" && open.has(b.id)) {
if (/running in the background|后台运行|后台任务/.test(b.content.slice(0, 200))) continue;
open.delete(b.id);
}
}
return open.size;
}, [blocks]);
const error = useStore((s) => s.error);
const wsStatus = useStore((s) => s.wsStatus);
const voiceSettings = useStore((s) => s.voiceSettings);
const recWake = useStore((s) => s.recWake);
const continuousVoice = useStore((s) => s.continuousVoice);
// 输入框下方的元信息行：信任模式开关（原在侧栏）+ 工号·用户名（原在侧栏页脚）。
const trustMode = useStore((s) => s.trustMode);
const setTrustMode = useStore((s) => s.setTrustMode);
const username = useStore((s) => s.username);
const employeeId = useStore((s) => s.employeeId);
const role = useStore((s) => s.role);
const t = useT();
const send = useStore((s) => s.send);
const interrupt = useStore((s) => s.interrupt);
// 草稿放 store：发送失败（ack 超时/断线）时能把文本放回输入框。
const draft = useStore((s) => s.draft);
const setDraft = useStore((s) => s.setDraft);
const [noSessionHint, setNoSessionHint] = useState(false);
const [busyHint, setBusyHint] = useState(false);
const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
const [attachHint, setAttachHint] = useState<string | null>(null);
const fileInputRef = useRef<HTMLInputElement>(null);
const appendDraft = useStore((s) => s.appendDraft);
const { recording, voiceMsg, toggleRecording } = useVoiceInput(currentSessionId, appendDraft);
const bottomRef = useRef<HTMLDivElement>(null);
// Picking a session clears the "no session" hint.
useEffect(() => {
if (currentSessionId) setNoSessionHint(false);
}, [currentSessionId]);
// The "still busy" hint only makes sense while busy — clear it with the state.
useEffect(() => {
if (!busy) setBusyHint(false);
}, [busy]);
// Switching sessions drops unsent attachments — they belong to that chat.
useEffect(() => {
setAttachments([]);
setAttachHint(null);
}, [currentSessionId]);
// Input-bar height and message font size, both user-adjustable and persisted.
const [inputH, setInputH] = useState(() => loadNum(LS.inputHeight, INPUT_H_DEFAULT));
const [chatFs, setChatFs] = useState(() =>
clamp(loadNum(LS.chatFontSize, CHAT_FS_DEFAULT), CHAT_FS_MIN, CHAT_FS_MAX),
);
useEffect(() => {
localStorage.setItem(LS.inputHeight, String(inputH));
}, [inputH]);
useEffect(() => {
localStorage.setItem(LS.chatFontSize, String(chatFs));
}, [chatFs]);
useEffect(() => {
bottomRef.current?.scrollIntoView({ behavior: "smooth" });
}, [blocks.length, streamingText]);

const canAttach = Boolean(currentSessionId) && !(sharedView && !ownerOnline);
const hint = (msg: string): void => {
setAttachHint(msg);
window.setTimeout(() => setAttachHint(null), 4000);
};

// Attach files from paste/drop/picker. Files with a real path (drag & drop,
// file picker) are referenced in place; clipboard content (screenshots) has
// no path, so the bytes are saved into this session's attachment store first.
const addFiles = async (files: File[]): Promise<void> => {
if (!canAttach) return;
for (const f of files) {
if (f.size > MAX_ATTACHMENT_BYTES) {
hint(t("chat.attachTooLarge", { name: f.name || "file" }));
continue;
}
let p = "";
try {
p = window.blm.pathForFile(f);
} catch {
p = "";
}
if (!p) {
try {
const bytes = new Uint8Array(await f.arrayBuffer());
const r = await window.blm.saveAttachment(currentSessionId!, f.name || "image.png", bytes);
if (!r.path) {
hint(t("chat.attachSaveFail", { name: f.name || "file", error: r.error ?? "" }));
continue;
}
p = r.path;
} catch (e) {
hint(
t("chat.attachSaveFail", {
name: f.name || "file",
error: e instanceof Error ? e.message : "",
}),
);
continue;
}
}
let dataUrl: string | undefined;
try {
const pv = await window.blm.previewAttachment(p);
if (pv.dataUrl) dataUrl = pv.dataUrl;
} catch {
// non-image or unreadable preview — the chip shows the plain 📎 icon
}
const name = f.name || p.split(/[\\/]/).pop() || "file";
setAttachments((a) => (a.some((x) => x.path === p) ? a : [...a, { name, path: p, dataUrl }]));
}
};

const submit = (): void => {
const text = draft.trim();
if ((!text && attachments.length === 0) || (sharedView && !ownerOnline)) return;
// 上一条还在生成：明确提示而不是静默吞掉——卡住的 busy（模型挂死等）
// 曾让用户「怎么发都没反应、没有任何状态」。
if (busy) {
setBusyHint(true);
return;
}
// No session selected: the store's send() would silently no-op — tell the
// user what to do instead, and keep the draft so nothing is lost.
if (!currentSessionId) {
setNoSessionHint(true);
return;
}
// Attachment lines ride in the message body: [附件] <name> → <abs path>.
// Mark them in the main process first: files kept at their original
// location (drag/pick) must stay readable even outside the access scope.
void window.blm.markAttachments(
currentSessionId,
attachments.map((a) => a.path),
);
const lines = attachments.map((a) => `[附件] ${a.name} → ${a.path}`);
const outgoing = [text, ...lines].filter(Boolean).join("\n\n");
// send 返回 false = 未发出（断线）：保留草稿和附件，用户可直接重试。
if (send(outgoing)) {
setDraft("");
setAttachments([]);
}
};
return (
<main
className="main"
style={{ "--chat-fs": `${chatFs}px` } as React.CSSProperties}
onWheel={(e) => {
// Shift+wheel over the chat zooms the message text (11–24px).
if (!e.shiftKey) return;
e.preventDefault();
setChatFs((f) => clamp(f + (e.deltaY < 0 ? 1 : -1), CHAT_FS_MIN, CHAT_FS_MAX));
}}
onDragOver={(e) => {
if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
}}
onDrop={(e) => {
const files = Array.from(e.dataTransfer?.files ?? []);
if (files.length) {
e.preventDefault();
void addFiles(files);
}
}}
>
{props.chrome && <PaneTools {...props.chrome} floating />}
{task && <FlowBar task={task} />}
<ChatMessages
blocks={blocks}
streamingText={streamingText}
error={error}
voiceMsg={voiceMsg}
noSession={!currentSessionId}
bottomRef={bottomRef}
/>
<Splitter
orientation="row"
label={t("pane.splitInput")}
onDrag={(y) => {
// The input bar hangs off the window bottom; dragging up grows it.
const h = clamp(window.innerHeight - y, INPUT_H_MIN, INPUT_H_MAX);
setInputH(h);
}}
onReset={() => setInputH(INPUT_H_DEFAULT)}
/>
{recording && (
<div className="rec-banner">
<span className="rec-dot" />
{recWake
? t(continuousVoice ? "chat.listeningContinuous" : "chat.listeningWake")
: voiceSettings.asrAutoSend
? t("chat.listeningAuto")
: t("chat.listeningDraft")}
</div>
)}
{/* 回合进行中掉线是最容易误读为「智能体不理人」的场景：显式横幅说明
    正在重连、回复会自动补上（连接状态小圆点太不显眼）。 */}
{wsStatus !== "connected" && busy && (
<div className="tool-block" style={{ color: "#e5a83a" }}>
⚠️ {t("chat.offlineBanner")}
</div>
)}
{noSessionHint && (
<div className="tool-block" style={{ color: "#e5a83a" }}>
💡 {t("chat.noSession")}
</div>
)}
{busyHint && (
<div className="tool-block" style={{ color: "#e5a83a" }}>
⏳ {t("chat.busyHint")}
</div>
)}
{/* 后台子代理仍在跑（主回复的 result 可能已到、busy 已复位）：显式提示，
    否则时间线里陆续出现的子代理块像「凭空冒出来的消息」。零协议方案：从
    未闭合的主线程委派调用推导（后台占位结果不闭合）。 */}
{subagentsRunning > 0 && (
<div className="tool-block" style={{ color: "var(--muted)" }}>
🤖 {t("chat.subagentsRunning", { n: subagentsRunning })}
</div>
)}
{attachHint && (
<div className="tool-block" style={{ color: "#e5a83a" }}>
📎 {attachHint}
</div>
)}
{sharedView && (
<div className="tool-block" style={{ color: "var(--muted)" }}>
{task
? `🧭 ${t("chat.taskBanner", {
executor: executorOfTask(task),
online: ownerOnline ? t("chat.executorOnline") : t("chat.executorOffline"),
})}`
: `🌐 ${t("chat.sharedBanner", {
owner: sharedOwner ?? "",
online: ownerOnline ? t("chat.ownerOnline") : t("chat.ownerOffline"),
})}`}
</div>
)}
{attachments.length > 0 && (
<div className="attach-row">
{attachments.map((a, i) => (
<span key={`${a.path}-${i}`} className="attach-chip" title={a.path}>
{a.dataUrl ? <img src={a.dataUrl} alt={a.name} /> : <span>📎</span>}
<span className="attach-name">{a.name}</span>
<button
className="attach-x"
title="移除"
onClick={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
>
×
</button>
</span>
))}
</div>
)}
<div className="input-bar" style={{ height: inputH }}>
<textarea
value={draft}
disabled={sharedView && !ownerOnline}
style={{ height: "100%", maxHeight: "none" }}
placeholder={
sharedView && !ownerOnline
? task
? t("chat.phExecutorOffline")
: t("chat.phOwnerOffline")
: recording
? t("chat.phRecording")
: currentSessionId
? t("chat.inputPh")
: t("chat.phNoSession")
}
onChange={(e) => setDraft(e.target.value)}
onKeyDown={(e) => {
if (e.key === "Enter" && !e.shiftKey) {
e.preventDefault();
submit();
} else if (e.key === "Escape") {
(e.target as HTMLTextAreaElement).blur();
}
}}
onPaste={(e) => {
const files = Array.from(e.clipboardData?.files ?? []);
if (files.length) {
e.preventDefault();
void addFiles(files);
}
}}
/>
<input
ref={fileInputRef}
type="file"
multiple
hidden
onChange={(e) => {
const fl = Array.from(e.target.files ?? []);
if (fl.length) void addFiles(fl);
e.target.value = "";
}}
/>
<button
title={canAttach ? t("chat.attach") : t("chat.attachDisabled")}
disabled={!canAttach}
style={{ fontSize: 18, padding: "8px 10px" }}
onClick={() => fileInputRef.current?.click()}
>
📎
</button>
<button
title={recording ? t("chat.micStop") : t("chat.mic")}
className={recording ? "recording" : ""}
style={{ fontSize: 18, padding: "8px 10px" }}
onClick={toggleRecording}
>
{recording ? "⏹" : "🎤"}
</button>
{busy ? (
<button className="primary" onClick={interrupt}>
{t("chat.stop")}
</button>
) : (
<button
className="primary"
disabled={(!draft.trim() && attachments.length === 0) || (sharedView && !ownerOnline)}
onClick={submit}
>
{t("chat.send")}
</button>
)}
</div>
<div className="input-meta">
<label title={t("side.trustTip")}>
<input
type="checkbox"
checked={trustMode}
onChange={(e) => setTrustMode(e.target.checked)}
/>
{t("side.trust")}
</label>
<span
className="who"
title={t("ft.identityTip", { name: username ?? "", eid: employeeId ?? "" })}
>
{t("ft.eid", { eid: employeeId ?? "—" })} · {username ?? "—"}
{role === "admin" && <span className="admin-badge">{t("ft.admin")}</span>}
</span>
<span className="grow" />
{lastUsage && (
<span className="usage">
{t("chat.usageLast", { input: lastUsage.input_tokens, output: lastUsage.output_tokens })}
{lastUsage.cost_usd != null ? ` ${t("chat.usageCost", { cost: lastUsage.cost_usd.toFixed(4) })}` : ""}
{totalUsage
? ` · ${t("chat.usageTotal", { input: totalUsage.input_tokens, output: totalUsage.output_tokens })}`
: ""}
</span>
)}
</div>
</main>
);
}
