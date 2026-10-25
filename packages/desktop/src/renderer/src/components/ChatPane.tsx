import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { LS } from "../store/persist";
import { ChatMessages } from "./chat/ChatMessages";
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
const sharedView = useStore((s) => s.sharedView);
const sharedOwner = useStore(
(s) => s.sharedSessions.find((x) => x.session_id === s.currentSessionId)?.owner ?? null,
);
// Own sessions are always "online"; shared ones follow the owner's presence.
const ownerOnline = useStore((s) => {
if (!s.sharedView || !s.currentSessionId) return true;
const owner = s.sharedSessions.find((x) => x.session_id === s.currentSessionId)?.owner;
if (!owner) return true;
return s.presence[owner] ?? false;
});
const blocks = useStore(
(s) => (currentSessionId ? s.blocksBySession[currentSessionId] : null) ?? EMPTY_BLOCKS,
);
const streamingText = useStore((s) =>
currentSessionId ? (s.streaming[currentSessionId] ?? "") : "",
);
const busy = useStore((s) => (currentSessionId ? (s.busy[currentSessionId] ?? false) : false));
const error = useStore((s) => s.error);
const voiceSettings = useStore((s) => s.voiceSettings);
const t = useT();
const send = useStore((s) => s.send);
const interrupt = useStore((s) => s.interrupt);
const [draft, setDraft] = useState("");
const [noSessionHint, setNoSessionHint] = useState(false);
const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
const [attachHint, setAttachHint] = useState<string | null>(null);
const fileInputRef = useRef<HTMLInputElement>(null);
const appendDraft = (text: string): void => setDraft((d) => (d ? d + " " : "") + text);
const { recording, voiceMsg, toggleRecording } = useVoiceInput(currentSessionId, appendDraft);
const bottomRef = useRef<HTMLDivElement>(null);
// Picking a session clears the "no session" hint.
useEffect(() => {
if (currentSessionId) setNoSessionHint(false);
}, [currentSessionId]);
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
if ((!text && attachments.length === 0) || busy || (sharedView && !ownerOnline)) return;
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
send([text, ...lines].filter(Boolean).join("\n\n"));
setDraft("");
setAttachments([]);
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
{voiceSettings.asrAutoSend
? t("chat.listeningAuto")
: t("chat.listeningDraft")}
</div>
)}
{noSessionHint && (
<div className="tool-block" style={{ color: "#e5a83a" }}>
💡 {t("chat.noSession")}
</div>
)}
{attachHint && (
<div className="tool-block" style={{ color: "#e5a83a" }}>
📎 {attachHint}
</div>
)}
{sharedView && (
<div className="tool-block" style={{ color: "var(--muted)" }}>
🌐 {t("chat.sharedBanner", {
owner: sharedOwner ?? "",
online: ownerOnline ? t("chat.ownerOnline") : t("chat.ownerOffline"),
})}
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
? t("chat.phOwnerOffline")
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
</main>
);
}
