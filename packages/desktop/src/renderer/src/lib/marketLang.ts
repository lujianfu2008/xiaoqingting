// 市场描述显示语言偏好（localStorage 持久化，两个市场面板共用）：
// zh = 中文（MCP 描述走服务端 LLM 翻译；技能用策展中文文案）；
// en = 原文英文。存不了（无痕模式等）就每次回默认中文。
export type MarketLang = "zh" | "en";

const KEY = "blm.marketLang";

export function getMarketLang(): MarketLang {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function setMarketLang(v: MarketLang): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // ignore
  }
}
