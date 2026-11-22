import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { fileToBase64 } from "../../store/actions/skills";
import { useT, type T } from "../../i18n";
import { getMarketLang, setMarketLang, type MarketLang } from "../../lib/marketLang";
import type { ImportSkillsResult, SkillInfo, SkillRegistryCard } from "@blm/protocol";

// 专家技能设置面板：技能列表（全局 + 我的）、安装表单（SKILL.md 全文）、
// 粘贴导入、压缩包安装、市场搜索。安装即可用（可停用/启用，可编辑 SKILL.md）；
// 同名安装即更新，删除即卸载。仅支持纯文档技能（SKILL.md），脚本型技能包
// 不在支持范围（压缩包导入时带脚本的技能组整组跳过并如实告知）。

type Scope = "user" | "global";

const SKIP_REASON_KEYS: Record<
  string,
  | "skills.skipInvalidName"
  | "skills.skipInvalidDef"
  | "skills.skipTooLarge"
  | "skills.skipScript"
  | "skills.skipDup"
> = {
  invalid_name: "skills.skipInvalidName",
  missing_frontmatter: "skills.skipInvalidDef",
  too_large: "skills.skipTooLarge",
  script_bundle: "skills.skipScript",
  dup_name: "skills.skipDup",
};

function sourceTagKey(info: SkillInfo): "skills.globalTag" | "skills.mineTag" {
  return info.source === "global" ? "skills.globalTag" : "skills.mineTag";
}

/** 批量导入结果 → 一行反馈文案（粘贴导入与压缩包安装共用）。 */
function describeImport(res: ImportSkillsResult, t: T): string {
  const parts: string[] = [];
  if (res.imported.length > 0) {
    parts.push(t("skills.importOk", { names: res.imported.join(", ") }));
  }
  if (res.skipped.length > 0) {
    const list = res.skipped
      .map((s) => {
        const key = SKIP_REASON_KEYS[s.reason];
        return `${s.name} (${key ? t(key) : s.reason})`;
      })
      .join(", ");
    parts.push(t("skills.importSkipped", { list }));
  }
  return parts.join("　") || t("skills.saveFail");
}

// ---------- 粘贴导入 ----------

function ImportBox({ scope }: { scope: Scope }): React.JSX.Element {
  const t = useT();
  const importSkills = useStore((s) => s.importSkills);
  const importGlobalSkills = useStore((s) => s.importGlobalSkills);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const res =
        scope === "global" ? await importGlobalSkills(text) : await importSkills(text);
      setMsg(describeImport(res, t));
      if (res.imported.length > 0) setText("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("skills.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t("skills.importTitle")}</div>
      <textarea
        style={{ width: "100%", minHeight: 56, fontSize: 11, fontFamily: "monospace" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("skills.importPh")}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button
          className="primary"
          style={{ fontSize: 12 }}
          disabled={busy || text.trim().length < 2}
          onClick={() => void run()}
        >
          {busy ? t("skills.importing") : t("skills.importBtn")}
        </button>
        {msg && (
          <span style={{ fontSize: 11, color: "var(--accent)", wordBreak: "break-all" }}>{msg}</span>
        )}
      </div>
    </div>
  );
}

// ---------- 压缩包安装（zip；服务端只提取 SKILL.md） ----------

function ArchiveBox({ scope }: { scope: Scope }): React.JSX.Element {
  const t = useT();
  const importArchive = useStore((s) =>
    scope === "global" ? s.importGlobalSkillsArchive : s.importSkillsArchive,
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (file: File): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const base64 = await fileToBase64(file);
      const res = await importArchive(base64, file.name);
      setMsg(describeImport(res, t));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("skills.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t("skills.archiveTitle")}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button style={{ fontSize: 12 }} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? t("skills.archiving") : t("skills.archiveBtn")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(f);
          }}
        />
        {msg && (
          <span style={{ fontSize: 11, color: "var(--accent)", wordBreak: "break-all" }}>{msg}</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
        {t("skills.archiveHint")}
      </div>
    </div>
  );
}

// ---------- 安装表单（新增；同名即更新；initial 有值 = 编辑模式，名称锁定） ----------

function SkillForm({
  scope,
  initial,
  onDone,
}: {
  scope: Scope;
  initial?: { name: string; markdown: string } | null;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const saveSkill = useStore((s) => (scope === "global" ? s.saveGlobalSkill : s.saveSkill));
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [markdown, setMarkdown] = useState(initial?.markdown ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setErr(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t("skills.errInvalidName"));
      return;
    }
    setBusy(true);
    try {
      await saveSkill(trimmed, markdown);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("skills.saveFail"));
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
        <label>{t("skills.name")}</label>
        <input
          value={name}
          disabled={editing}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("skills.namePh")}
        />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("skills.markdown")}</label>
        <textarea
          style={{ minHeight: 120, fontSize: 11, fontFamily: "monospace" }}
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          placeholder={t("skills.markdownPh")}
        />
      </div>
      {err && <div className="error-text">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => void submit()}>
          {t("skills.save")}
        </button>
        <button style={{ fontSize: 12 }} disabled={busy} onClick={onDone}>
          {t("skills.cancel")}
        </button>
      </div>
    </div>
  );
}

// ---------- 技能区块（列表 + 安装 + 导入） ----------

function SkillSection({ scope, title }: { scope: Scope; title: string }): React.JSX.Element {
  const t = useT();
  const skills = useStore((s) => (scope === "global" ? s.globalSkills : s.skills));
  const deleteSkill = useStore((s) =>
    scope === "global" ? s.deleteGlobalSkill : s.deleteSkill,
  );
  const readSkillMd = useStore((s) =>
    scope === "global" ? s.readGlobalSkill : s.readSkill,
  );
  const setEnabled = useStore((s) =>
    scope === "global" ? s.setGlobalSkillEnabled : s.setSkillEnabled,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<{ name: string; markdown: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const remove = async (info: SkillInfo): Promise<void> => {
    if (!window.confirm(t("skills.deleteConfirm", { name: info.name }))) return;
    setErr(null);
    try {
      await deleteSkill(info.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("skills.saveFail"));
    }
  };

  const edit = async (info: SkillInfo): Promise<void> => {
    setErr(null);
    try {
      const markdown = await readSkillMd(info.name);
      setEditing({ name: info.name, markdown });
      setFormOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("skills.saveFail"));
    }
  };

  const toggle = async (info: SkillInfo): Promise<void> => {
    setErr(null);
    try {
      await setEnabled(info.name, info.enabled === false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("skills.saveFail"));
    }
  };

  const openForm = (): void => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
        <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={openForm}>
          {t("skills.add")}
        </button>
      </div>

      {formOpen && (
        <SkillForm
          key={editing?.name ?? "__new__"}
          scope={scope}
          initial={editing}
          onDone={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(skills ?? []).length === 0 && (
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{t("skills.empty")}</div>
        )}
        {(skills ?? []).map((info) => {
          const disabled = info.enabled === false;
          return (
            <div
              key={info.name}
              style={{
                border: "1px solid var(--border, #ccc)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
                opacity: disabled ? 0.55 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong>{info.title || info.name}</strong>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>{info.name}</span>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>
                  {t(sourceTagKey(info))}
                </span>
                {disabled && (
                  <span style={{ fontSize: 10, color: "var(--accent)" }}>
                    {t("skills.disabledTag")}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => void edit(info)}
                >
                  {t("skills.edit")}
                </button>
                <button
                  style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => void toggle(info)}
                >
                  {disabled ? t("skills.enable") : t("skills.disable")}
                </button>
                <button
                  style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => void remove(info)}
                >
                  {t("skills.delete")}
                </button>
              </div>
              {info.description && (
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, wordBreak: "break-all" }}>
                  {info.description}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// ---------- 市场（清单搜索 + 一键安装） ----------

function MarketSection({
  lang,
  onSwitchLang,
}: {
  lang: MarketLang;
  onSwitchLang: (v: MarketLang) => void;
}): React.JSX.Element {
  const t = useT();
  const isAdmin = useStore((s) => s.role) === "admin";
  const searchSkillRegistry = useStore((s) => s.searchSkillRegistry);
  const installSkill = useStore((s) => s.installSkill);
  const installGlobalSkill = useStore((s) => s.installGlobalSkill);
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<SkillRegistryCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({}); // card.id → 已安装名
  const [err, setErr] = useState<string | null>(null);

  const search = async (): Promise<void> => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await searchSkillRegistry(query);
      setCards(res.skills);
      setDone({});
    } catch (e) {
      // 每次查找的结果只属于这次查找：失败时清掉上一轮的列表再报错，
      // 绝不让旧结果冒充本次的命中（历史记录残留不符合直觉）。
      setCards(null);
      setDone({});
      setErr(e instanceof Error ? e.message : t("skills.registryFail"));
    } finally {
      setBusy(false);
    }
  };

  const install = async (card: SkillRegistryCard, toGlobal: boolean): Promise<void> => {
    setInstalling(card.id);
    setErr(null);
    try {
      // 服务端可能对名字做了规范化（返回最终落库名），以它为准展示。
      const res = toGlobal
        ? await installGlobalSkill(card.install_name, card.url)
        : await installSkill(card.install_name, card.url);
      setDone((d) => ({ ...d, [card.id]: res?.name ?? card.install_name }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("skills.saveFail"));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t("skills.marketTitle")}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("market.lang")}</span>
        {(["zh", "en"] as const).map((v) => (
          <button
            key={v}
            className={lang === v ? "primary" : ""}
            style={{ fontSize: 11 }}
            onClick={() => {
              if (v === lang) return;
              // 先落地语言再搜：search 读 getMarketLang()，后切会拿旧语言
              // 搜出旧语言的卡片（看起来像残留的历史结果）。
              onSwitchLang(v);
              if (q.trim() && cards !== null) void search();
            }}
          >
            {v === "zh" ? t("market.langZh") : t("market.langEn")}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ flex: 1 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("skills.marketPh")}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        <button
          className="primary"
          style={{ fontSize: 12 }}
          disabled={busy || !q.trim()}
          onClick={() => void search()}
        >
          {busy ? t("skills.searching") : t("skills.search")}
        </button>
      </div>
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
      {cards === null ? (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          {t("skills.marketStart")}
        </div>
      ) : cards.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          {t("skills.marketEmpty")}
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
                    {t("skills.installed", { name: done[card.id] })}
                  </span>
                )}
                {card.version && (
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>v{card.version}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {card.description}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                {!done[card.id] && (
                  <button
                    className="primary"
                    style={{ fontSize: 11, padding: "1px 10px" }}
                    disabled={installing === card.id}
                    onClick={() => void install(card, false)}
                  >
                    {t("skills.install")}
                  </button>
                )}
                {isAdmin && !done[card.id] && (
                  <button
                    style={{ fontSize: 11, padding: "1px 10px" }}
                    disabled={installing === card.id}
                    onClick={() => void install(card, true)}
                  >
                    {t("skills.installGlobal")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillsPanel(): React.JSX.Element {
  const t = useT();
  const role = useStore((s) => s.role);
  const loadSkills = useStore((s) => s.loadSkills);
  const loadGlobalSkills = useStore((s) => s.loadGlobalSkills);
  const isAdmin = role === "admin";
  // 描述语言（与市场开关共用偏好）：切换时市场自动重搜、已安装列表重拉。
  const [lang, setLang] = useState<MarketLang>(getMarketLang());

  useEffect(() => {
    void loadSkills();
    if (isAdmin) void loadGlobalSkills();
    // 面板常驻挂载（settings 各 tab 均不卸载），仅按管理员身份拉取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const switchLang = (v: MarketLang): void => {
    if (v === lang) return;
    setLang(v);
    setMarketLang(v);
    void loadSkills();
    if (isAdmin) void loadGlobalSkills();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 520 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {t("skills.note")}
      </div>
      <SkillSection scope="user" title={t("skills.listMine")} />
      <ImportBox scope="user" />
      <ArchiveBox scope="user" />
      <MarketSection lang={lang} onSwitchLang={switchLang} />
      {isAdmin && (
        <>
          <div
            style={{ borderTop: "1px solid var(--border, #ccc)", margin: "4px 0 12px" }}
          />
          <SkillSection scope="global" title={t("skills.listGlobal")} />
          <ImportBox scope="global" />
          <ArchiveBox scope="global" />
        </>
      )}
    </div>
  );
}
