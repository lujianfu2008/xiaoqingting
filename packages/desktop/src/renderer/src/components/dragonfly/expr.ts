// Avatar state + emotion vocabulary shared by the 小蜻蜓 SVG and the 3D avatar.

export type DflyState = "idle" | "thinking" | "speaking" | "listening";
export type DflyExpr =
  | "normal"
  | "happy"
  | "sad"
  | "surprised"
  | "curious"
  | "serious";

const EXPR_VALUES = new Set([
  "happy",
  "sad",
  "surprised",
  "curious",
  "serious",
]);

export function normalizeExpr(raw?: string): DflyExpr {
  if (!raw) return "normal";
  switch (raw) {
    case "开心":
    case "happy":
      return "happy";
    case "难过":
    case "抱歉":
    case "sad":
      return "sad";
    case "惊讶":
    case "surprised":
      return "surprised";
    case "疑惑":
    case "好奇":
    case "curious":
      return "curious";
    case "严肃":
    case "serious":
      return "serious";
    default:
      return "normal";
  }
}

export { EXPR_VALUES };
