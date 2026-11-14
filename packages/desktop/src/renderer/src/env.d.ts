// Ambient declarations for the renderer process.

/// <reference types="vite/client" />

import type {
  ViewerListDirResult,
  ViewerOpenDialogResult,
  ViewerReadResult,
  ViewerStatResult,
} from "@blm/protocol";

declare global {
  interface BrowserState {
    mode: "embedded" | "popup";
    open: boolean;
    url: string;
    title: string;
    /** The focused session this state describes. */
    session_id: string;
  }

  // Mirrors main/executor/accessScope.ts accessScopeState().
  interface AccessScopeState {
    workDir: string | null;
    /** Effective mode — for the requested project when one was passed. */
    mode: "workspace" | "full" | "custom";
    folders: string[];
    /** Present only when a project was queried: its override (null = 全局). */
    projectMode?: "workspace" | "full" | "custom" | null;
  }

  interface Window {
    blm: {
      platform: string;
      versions: { app: string };
      executeLocalAction(request: {
        action: string;
        params: Record<string, unknown>;
        session_id?: string;
}): Promise<{ ok: boolean; output?: string; error?: string; images?: { media_type: string; data: string }[] }>;
      bindProjectFolder(
        projectId: string,
        opts: { name?: string; choose: boolean },
      ): Promise<{ ok: boolean; folder?: string; error?: string }>;
      getProjectFolder(projectId: string): Promise<{ folder: string | null }>;
      setSessionProject(sessionId: string, projectId: string | null): Promise<void>;
      forgetSession(sessionId: string): Promise<void>;
      onOpenSettings(cb: () => void): () => void;
      onOpenFiles(cb: () => void): () => void;
      getLanguage(): Promise<string>;
      setLanguage(lang: "system" | "zh-CN" | "en"): Promise<string>;
      checkLocalLogin(userOrEid: string): Promise<{ locked: boolean }>;
      acquireLocalLogin(employeeId: string, username: string): Promise<void>;
      releaseLocalLogin(): Promise<void>;
      onLangChanged(cb: (lang: string) => void): () => void;
      getPrefs(): Promise<{ closeAction: "quit" | "tray" }>;
      setCloseAction(v: "quit" | "tray"): Promise<"quit" | "tray">;
      accessScope: {
        get(projectId?: string): Promise<AccessScopeState>;
        setMode(mode: AccessScopeState["mode"], projectId?: string): Promise<AccessScopeState>;
        setProjectMode(
          projectId: string,
          mode: AccessScopeState["mode"] | null,
        ): Promise<AccessScopeState>;
        addFolder(): Promise<AccessScopeState & { folder: string | null }>;
        removeFolder(folder: string): Promise<AccessScopeState>;
      };
      speakText(
        text: string,
        opts?: { voice?: string; rate?: number; volume?: number },
      ): Promise<{ audio?: Uint8Array; error?: string }>;
      stopSpeaking(): Promise<void>;
      listVoices(): Promise<{ name: string; culture: string }[]>;
      transcribeLocalPcm(pcm: ArrayBuffer, pauses?: number[]): Promise<{ text: string; error?: string }>;
      wakeConfigure(words: string[], sensitivity: "low" | "medium" | "high"): Promise<{ error?: string }>;
      wakeChunk(pcm: ArrayBuffer): void;
      wakeStop(): void;
      onWakeDetected(cb: (keyword: string) => void): () => void;
      focusWindow(): Promise<void>;
      notify(args: { title: string; body?: string; session_id?: string }): Promise<void>;
      onNotifyActivate(cb: (sessionId: string | null) => void): () => void;
      bindUpdater(serverUrl: string): Promise<void>;
      checkUpdate(): Promise<"up_to_date" | "available" | "error">;
      onUpdateProgress(
        cb: (s: {
          phase: "idle" | "downloading" | "downloaded";
          percent: number;
          transferred?: number;
          total?: number;
          bytesPerSecond?: number;
        }) => void,
      ): () => void;
      relayConfigure(req: {
        server_url: string;
        token: string;
        enabled: boolean;
      }): Promise<{ ok: boolean; error?: string }>;
      relayStatus(): Promise<{
        enabled: boolean;
        connected: boolean;
        active_requests: number;
        requests_total: number;
        requests_failed: number;
      }>;
      pathForFile(file: File): string;
      saveAttachment(
        sessionId: string,
        name: string,
        bytes: Uint8Array,
      ): Promise<{ path?: string; error?: string }>;
      previewAttachment(path: string): Promise<{ dataUrl?: string; error?: string }>;
      markAttachments(sessionId: string, paths: string[]): Promise<void>;
      exportChat(req: {
        default_filename: string;
        markdown: string;
      }): Promise<{ saved: boolean; path: string | null; error?: string }>;
      viewer: {
        stat(path: string): Promise<ViewerStatResult>;
        listDir(path: string): Promise<ViewerListDirResult>;
        read(path: string): Promise<ViewerReadResult>;
        openDialog(): Promise<ViewerOpenDialogResult>;
        popOut(path: string): Promise<{ error?: string }>;
        openExternal(path: string): Promise<{ error?: string }>;
      };
      browser: {
        state(): Promise<BrowserState>;
        setActiveSession(sessionId: string | null): Promise<void>;
        setBounds(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
        setMode(mode: "embedded" | "popup"): Promise<BrowserState>;
        open(url: string): Promise<{ ok: boolean; error?: string }>;
        close(): Promise<void>;
        onState(cb: (s: BrowserState) => void): () => void;
      };
    };
  }
}

export {};
