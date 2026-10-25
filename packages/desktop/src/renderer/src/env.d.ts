// Ambient declarations for the renderer process.

declare global {
  interface BrowserState {
    mode: "embedded" | "popup";
    open: boolean;
    url: string;
    title: string;
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
      getLanguage(): Promise<string>;
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
      transcribeLocalPcm(pcm: ArrayBuffer): Promise<{ text: string; error?: string }>;
      pathForFile(file: File): string;
      saveAttachment(
        sessionId: string,
        name: string,
        bytes: Uint8Array,
      ): Promise<{ path?: string; error?: string }>;
      previewAttachment(path: string): Promise<{ dataUrl?: string; error?: string }>;
      markAttachments(sessionId: string, paths: string[]): Promise<void>;
      browser: {
        state(): Promise<BrowserState>;
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
