import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import type { McpRegistryCard, McpServerDef, McpServerInfo } from "@blm/protocol";

// MCP 设置面板：服务器列表（全局 + 我的）、表单增改、从市场粘贴导入。
// 普通用户只能添加远程 http/sse 服务器；管理员另有全局区块（含 stdio）。
// 配置保存在服务端，写入后空闲会话被重建，下一条消息生效。

type Scope = "user" | "global";

const TYPE_KEYS: Record<string, "mcp.typeStdio" | "mcp.typeHttp" | "mcp.typeSse"> = {
  stdio: "mcp.typeStdio",
  http: "mcp.typeHttp",
  sse: "mcp.typeSse",
};

const SKIP_REASON_KEYS: Record<string, "mcp.skipInvalidName" | "mcp.skipReserved" | "mcp.skipInvalidDef" | "mcp.skipStdio" | "mcp.errInvalidUrl" | "mcp.errPrivateUrl" | "mcp.errUnresolvable"> = {
  invalid_name: "mcp.skipInvalidName",
  reserved_name: "mcp.skipReserved",
  invalid_def: "mcp.skipInvalidDef",
  stdio_forbidden: "mcp.skipStdio",
  invalid_url: "mcp.errInvalidUrl",
  private_url: "mcp.errPrivateUrl",
  unresolvable_host: "mcp.errUnresolvable",
};

function parseKv(text: string, sep: ":" | "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const i = trimmed.indexOf(sep);
    if (i <= 0) continue;
    const k = trimmed.slice(0, i).trim();
    if (k) out[k] = trimmed.slice(i + 1).trim();
  }
  return out;
}

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function headersToText(h?: Record<string, string>): string {
  return Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function kvToText(m?: Record<string, string>): string {
  return Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function listToText(a?: string[]): string {
  return (a ?? []).join("\n");
}

function mainLine(def: McpServerDef): string {
  if (def.type === "stdio") {
    return [def.command ?? "", ...(def.args ?? [])].filter(Boolean).join(" ");
  }
  return def.url ?? "";
}

function sourceTagKey(info: McpServerInfo): "mcp.globalTag" | "mcp.mineTag" {
  return info.source === "global" ? "mcp.globalTag" : "mcp.mineTag";
}

// ---------- 粘贴导入 ----------

function ImportBox({ scope }: { scope: Scope }): React.JSX.Element {
  const t = useT();
  const importMcpServers = useStore((s) => s.importMcpServers);
  const importGlobalMcpServers = useStore((s) => s.importGlobalMcpServers);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const res =
        scope === "global"
          ? await importGlobalMcpServers(text)
          : await importMcpServers(text);
      const parts: string[] = [];
      if (res.imported.length > 0) {
        parts.push(t("mcp.importOk", { names: res.imported.join(", ") }));
      }
      if (res.skipped.length > 0) {
        const list = res.skipped
          .map((s) => {
            const key = SKIP_REASON_KEYS[s.reason];
            return `${s.name} (${key ? t(key) : s.reason})`;
          })
          .join(", ");
        parts.push(t("mcp.importSkipped", { list }));
      }
      setMsg(parts.join("　") || t("mcp.importFail"));
      if (res.imported.length > 0) setText("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("mcp.importFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t("mcp.importTitle")}</div>
      <textarea
        style={{ width: "100%", minHeight: 56, fontSize: 11, fontFamily: "monospace" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("mcp.importPh")}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button
          className="primary"
          style={{ fontSize: 12 }}
          disabled={busy || text.trim().length < 2}
          onClick={() => void run()}
        >
          {busy ? t("mcp.importing") : t("mcp.importBtn")}
        </button>
        {msg && (
          <span style={{ fontSize: 11, color: "var(--accent)", wordBreak: "break-all" }}>{msg}</span>
        )}
      </div>
    </div>
  );
}

// ---------- 添加 / 编辑表单 ----------

interface FormState {
  name: string | null; // null = 新增
  def: McpServerDef;
}

function ServerForm({
  scope,
  initial,
  onDone,
}: {
  scope: Scope;
  initial: FormState;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const saveServer = useStore((s) => (scope === "global" ? s.saveGlobalMcpServer : s.saveMcpServer));
  const [name, setName] = useState(initial.name ?? "");
  const [type, setType] = useState<McpServerDef["type"]>(initial.def.type);
  const [url, setUrl] = useState(initial.def.url ?? "");
  const [headers, setHeaders] = useState(headersToText(initial.def.headers));
  const [command, setCommand] = useState(initial.def.command ?? "");
  const [args, setArgs] = useState(listToText(initial.def.args));
  const [env, setEnv] = useState(kvToText(initial.def.env));
  const [enabled, setEnabled] = useState(initial.def.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setErr(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr(t("mcp.errInvalidName"));
      return;
    }
    const def: McpServerDef = {
      type,
      enabled,
      ...(type === "stdio"
        ? { command: command.trim(), args: parseLines(args), env: parseKv(env, "=") }
        : { url: url.trim(), headers: parseKv(headers, ":") }),
    };
    setBusy(true);
    try {
      if (initial.name) await saveServer(initial.name, def);
      else await saveServer(trimmedName, def);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("mcp.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border, #ccc)",
        borderRadius: 6,
        padding: 10,
        margin: "8px 0",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("mcp.name")}</label>
        <input
          value={name}
          disabled={!!initial.name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcp.namePh")}
        />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("mcp.type")}</label>
        <select value={type} onChange={(e) => setType(e.target.value as McpServerDef["type"])}>
          <option value="http">{t("mcp.typeHttp")}</option>
          <option value="sse">{t("mcp.typeSse")}</option>
          {scope === "global" && <option value="stdio">{t("mcp.typeStdio")}</option>}
        </select>
      </div>
      {type === "stdio" ? (
        <>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("mcp.command")}</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("mcp.commandPh")}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("mcp.args")}</label>
            <textarea
              style={{ minHeight: 48, fontSize: 11 }}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t("mcp.argsPh")}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("mcp.env")}</label>
            <input
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="KEY=VALUE"
            />
          </div>
          <div style={{ fontSize: 11, color: "#c66" }}>{t("mcp.stdioWarn")}</div>
        </>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("mcp.url")}</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("mcp.urlPh")}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("mcp.headers")}</label>
            <textarea
              style={{ minHeight: 40, fontSize: 11 }}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={t("mcp.headersPh")}
            />
          </div>
        </>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("mcp.enabled")}
      </label>
      {err && <div className="error-text">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => void submit()}>
          {t("mcp.save")}
        </button>
        <button style={{ fontSize: 12 }} disabled={busy} onClick={onDone}>
          {t("mcp.cancel")}
        </button>
      </div>
    </div>
  );
}

// ---------- 服务器区块（列表 + 表单 + 导入） ----------

function ServerSection({ scope, title }: { scope: Scope; title: string }): React.JSX.Element {
  const t = useT();
  const servers = useStore((s) => (scope === "global" ? s.globalMcpServers : s.mcpServers));
  const saveServer = useStore((s) => (scope === "global" ? s.saveGlobalMcpServer : s.saveMcpServer));
  const deleteServer = useStore((s) =>
    scope === "global" ? s.deleteGlobalMcpServer : s.deleteMcpServer,
  );
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (info: McpServerInfo): Promise<void> => {
    setErr(null);
    try {
      await saveServer(info.name, { ...info, enabled: info.enabled === false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("mcp.saveFail"));
    }
  };

  const remove = async (info: McpServerInfo): Promise<void> => {
    if (!window.confirm(t("mcp.deleteConfirm", { name: info.name }))) return;
    setErr(null);
    try {
      await deleteServer(info.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("mcp.saveFail"));
    }
  };

  const canEdit = (info: McpServerInfo): boolean => scope === "global" || info.source === "user";
  // 「覆盖」：以我的同名配置覆盖全局条目（stdio 全局条目用户无法复制，不给入口）。
  const canCover = (info: McpServerInfo): boolean =>
    scope === "user" && info.source === "global" && info.type !== "stdio";

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
        <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setForm({ name: null, def: { type: "http", enabled: true } })}>
          {t("mcp.add")}
        </button>
      </div>

      {form && (
        <ServerForm scope={scope} initial={form} onDone={() => setForm(null)} />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(servers ?? []).length === 0 && (
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{t("mcp.empty")}</div>
        )}
        {(servers ?? []).map((info) => (
          <div
            key={info.name}
            style={{
              border: "1px solid var(--border, #ccc)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              opacity: info.enabled === false ? 0.55 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong>{info.name}</strong>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>
                [{t(TYPE_KEYS[info.type])}]
              </span>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>
                {t(sourceTagKey(info))}
              </span>
              {info.overrides_global && (
                <span style={{ fontSize: 10, color: "var(--accent)" }}>{t("mcp.overridesTag")}</span>
              )}
              {info.enabled === false && (
                <span style={{ fontSize: 10, color: "var(--muted)" }}>{t("mcp.enabledTag")}</span>
              )}
              <span style={{ flex: 1 }} />
              {canEdit(info) && (
                <>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={info.enabled !== false}
                      onChange={() => void toggle(info)}
                    />
                    {t("mcp.enabled")}
                  </label>
                  <button
                    style={{ fontSize: 11, padding: "1px 8px" }}
                    onClick={() =>
                      setForm({
                        name: info.name,
                        def: { ...info, headers: info.headers ?? {} },
                      })
                    }
                  >
                    {t("mcp.edit")}
                  </button>
                  <button
                    style={{ fontSize: 11, padding: "1px 8px" }}
                    onClick={() => void remove(info)}
                  >
                    {t("mcp.delete")}
                  </button>
                </>
              )}
              {canCover(info) && (
                <button
                  style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => setForm({ name: info.name, def: { ...info, headers: {} } })}
                >
                  {t("mcp.cover")}
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all", marginTop: 2 }}>
              {mainLine(info) || "—"}
              {info.headers_redacted && ` · ${t("mcp.headersHidden")}`}
            </div>
          </div>
        ))}
      </div>
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// ---------- 市场（官方 Registry 搜索 + 一键安装） ----------

function CardBadges({ card }: { card: McpRegistryCard }): React.JSX.Element {
  const t = useT();
  return (
    <>
      {card.remote && (
        <span style={{ fontSize: 10, color: "var(--muted)" }}>[{t("mcp.badgeRemote")}]</span>
      )}
      {card.pkg && (
        <span style={{ fontSize: 10, color: "var(--muted)" }}>[{t("mcp.badgePkg")}]</span>
      )}
      {card.remote?.needs_auth && (
        <span style={{ fontSize: 10, color: "#c66" }}>{t("mcp.needAuth")}</span>
      )}
    </>
  );
}

function MarketSection(): React.JSX.Element {
  const t = useT();
  const isAdmin = useStore((s) => s.role) === "admin";
  const searchMcpRegistry = useStore((s) => s.searchMcpRegistry);
  const saveMcpServer = useStore((s) => s.saveMcpServer);
  const saveGlobalMcpServer = useStore((s) => s.saveGlobalMcpServer);
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<McpRegistryCard[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({}); // card.id → 已安装为 xxx
  const [note, setNote] = useState<Record<string, string>>({}); // card.id → 安装后提示
  const [err, setErr] = useState<string | null>(null);

  const search = async (fresh: boolean): Promise<void> => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await searchMcpRegistry(query, fresh ? undefined : (cursor ?? undefined));
      setCards(fresh ? res.servers : [...(cards ?? []), ...res.servers]);
      setCursor(res.next_cursor ?? null);
      if (fresh) {
        setDone({});
        setNote({});
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("mcp.registryFail"));
    } finally {
      setBusy(false);
    }
  };

  const install = async (card: McpRegistryCard, toGlobal: boolean): Promise<void> => {
    setInstalling(card.id);
    setErr(null);
    try {
      if (toGlobal && card.pkg) {
        const id = card.pkg.version
          ? `${card.pkg.identifier}@${card.pkg.version}`
          : card.pkg.identifier;
        // npm 走 npx -y；pypi 走 uvx。
        const args = card.pkg.registry_type === "npm" ? ["-y", id] : [id];
        await saveGlobalMcpServer(card.install_name, {
          type: "stdio",
          command: card.pkg.registry_type === "npm" ? "npx" : "uvx",
          args,
          enabled: true,
        });
      } else if (card.remote) {
        await saveMcpServer(card.install_name, {
          type: card.remote.type,
          url: card.remote.url,
          enabled: true,
        });
      } else return;
      setDone((d) => ({ ...d, [card.id]: card.install_name }));
      setNote((n) => ({
        ...n,
        [card.id]:
          (toGlobal && card.pkg?.env_required?.length) || card.remote?.needs_auth
            ? t("mcp.needAuthTip")
            : "",
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("mcp.saveFail"));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t("mcp.marketTitle")}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ flex: 1 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("mcp.marketPh")}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search(true);
          }}
        />
        <button
          className="primary"
          style={{ fontSize: 12 }}
          disabled={busy || !q.trim()}
          onClick={() => void search(true)}
        >
          {busy ? t("mcp.searching") : t("mcp.search")}
        </button>
      </div>
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
      {cards === null ? (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          {t("mcp.marketStart")}
        </div>
      ) : cards.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          {t("mcp.marketEmpty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {cards.map((card) => (
            <div
              key={card.id}
              style={{
                border: "1px solid var(--border, #ccc)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong>{card.title || card.install_name}</strong>
                {done[card.id] && (
                  <span style={{ fontSize: 10, color: "var(--accent)" }}>
                    {t("mcp.installed", { name: done[card.id] })}
                  </span>
                )}
                <CardBadges card={card} />
                {card.version && (
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>v{card.version}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {card.description}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                {card.remote && !done[card.id] && (
                  <button
                    className="primary"
                    style={{ fontSize: 11, padding: "1px 10px" }}
                    disabled={installing === card.id}
                    onClick={() => void install(card, false)}
                  >
                    {t("mcp.installRemote")}
                  </button>
                )}
                {card.pkg && !done[card.id] && isAdmin && (
                  <button
                    style={{ fontSize: 11, padding: "1px 10px" }}
                    disabled={installing === card.id}
                    onClick={() => void install(card, true)}
                  >
                    {t("mcp.installGlobal")}
                  </button>
                )}
                {card.pkg && !isAdmin && (
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>
                    {t("mcp.adminOnlyPkg")}
                  </span>
                )}
                {card.pkg?.env_required && (
                  <span style={{ fontSize: 10, color: "#c66" }}>
                    {t("mcp.envRequired", { names: card.pkg.env_required.join(", ") })}
                  </span>
                )}
                {note[card.id] && (
                  <span style={{ fontSize: 10, color: "var(--accent)" }}>{note[card.id]}</span>
                )}
              </div>
            </div>
          ))}
          {cursor && (
            <button
              style={{ fontSize: 11, padding: "2px 10px", alignSelf: "center" }}
              disabled={busy}
              onClick={() => void search(false)}
            >
              {t("mcp.loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function McpPanel(): React.JSX.Element {
  const t = useT();
  const role = useStore((s) => s.role);
  const loadMcpServers = useStore((s) => s.loadMcpServers);
  const loadGlobalMcpServers = useStore((s) => s.loadGlobalMcpServers);
  const isAdmin = role === "admin";

  useEffect(() => {
    void loadMcpServers();
    if (isAdmin) void loadGlobalMcpServers();
    // 面板常驻挂载（settings 各 tab 均不卸载），仅按管理员身份拉取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 520 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {t("mcp.note")}
      </div>
      <ServerSection scope="user" title={t("mcp.listMine")} />
      <ImportBox scope="user" />
      <MarketSection />
      {isAdmin && (
        <>
          <div
            style={{ borderTop: "1px solid var(--border, #ccc)", margin: "4px 0 12px" }}
          />
          <ServerSection scope="global" title={t("mcp.listGlobal")} />
          <ImportBox scope="global" />
        </>
      )}
    </div>
  );
}
