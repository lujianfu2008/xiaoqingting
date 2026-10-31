import path from "node:path";
import fs from "node:fs";

// Load .env from the server package dir (does not override already-set vars).
// Covers both app config and SDK-required ANTHROPIC_* / CLAUDE_CODE_* vars.
(function loadDotEnv(): void {
  const file = path.resolve(import.meta.dirname, "../.env");
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // no .env — fall back to process env only
  }
})();

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env("PORT", "8788")),
  host: env("HOST", "0.0.0.0"),
  jwtSecret: env("JWT_SECRET", "dev-secret-change-me"),
  username: env("BLMA_USERNAME", "admin"),
  password: env("BLMA_PASSWORD", "admin"),
  // Display-only 工号 for the bootstrap account.
  employeeId: env("BLMA_EMPLOYEE_ID", env("BLMA_USERNAME", "admin")),
  // Encrypts per-user LLM API keys at rest (falls back to JWT_SECRET).
  credentialSecret: env(
    "CREDENTIAL_SECRET",
    env("JWT_SECRET", "dev-secret-change-me"),
  ),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  engineCwd: path.join(path.resolve(env("DATA_DIR", "./data")), "engine"),
  permissionTimeoutMs: Number(env("PERMISSION_TIMEOUT_MS", "300000")),
  sessionIdleMs: Number(env("SESSION_IDLE_MS", "600000")),
  maxTurns: Number(env("MAX_TURNS", "50")),
  maxBudgetUsd: Number(env("MAX_BUDGET_USD", "5")),
  revealUsage: env("REVEAL_USAGE", "false") === "true",
  // Cloud ASR (defaults to the Zhipu BigModel endpoint, reusing the LLM token)
  asrBaseUrl: env("ASR_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
  asrApiKey: env("ASR_API_KEY", process.env.ANTHROPIC_AUTH_TOKEN ?? ""),
  asrModel: env("ASR_MODEL", "glm-asr"),
  // 官方 MCP Registry（市场搜索代理的上游），自建镜像时可换。
  mcpRegistryUrl: env("MCP_REGISTRY_URL", "https://registry.modelcontextprotocol.io"),
  // 专家技能市场清单 URL（JSON：{"skills":[...]}）；空 = 市场搜索不可用，
  // 安装/粘贴导入不受影响。
  skillsRegistryUrl: env("SKILLS_REGISTRY_URL", ""),
};

export function ensureDataDirs(): void {
  fs.mkdirSync(path.join(config.dataDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "workspaces"), { recursive: true });
  // 公有域项目工作空间（共有知识库文件所在）+ 更新申请记录。
  fs.mkdirSync(path.join(config.dataDir, "public-projects"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "update-requests"), { recursive: true });
  // 专家技能（全局插件目录；用户级在首次安装时按用户名创建）。
  fs.mkdirSync(path.join(config.dataDir, "skills", "global"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "skills", "users"), { recursive: true });
  // Neutral engine working dir: the SDK injects its cwd into the model's
  // context, so it must not point at user-specific workspace paths.
  fs.mkdirSync(path.join(config.dataDir, "engine"), { recursive: true });
}
