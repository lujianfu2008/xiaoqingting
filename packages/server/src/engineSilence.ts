// 引擎运行时会以 developer warning 形式输出诊断信息（code 形如
// "XXX_SDK_*"），Node 默认格式会连同 code 一起打到进程 stderr →
// 服务日志。为避免服务日志暴露引擎品牌，这里按 code 前缀静默丢弃
// 该类警告（只影响输出，不影响任何运行行为）。其余警告照常输出。
// 本模块必须在任何引擎相关 import 之前执行（index.ts 首行 import）。
if (!(globalThis as { __engineWarnSilenced?: boolean }).__engineWarnSilenced) {
  (globalThis as { __engineWarnSilenced?: boolean }).__engineWarnSilenced = true;
  const origEmitWarning = process.emitWarning.bind(process) as (
    ...args: unknown[]
  ) => void;

  process.emitWarning = ((warn: unknown, ...args: unknown[]) => {
    const first = args[0];
    const code =
      typeof first === "string"
        ? first
        : (first as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code.toUpperCase().startsWith("CLAUDE_")) {
      return;
    }
    return origEmitWarning(warn, ...args);
  }) as typeof process.emitWarning;
}
