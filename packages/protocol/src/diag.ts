import { z } from "zod";

// ---------- 客户端显示诊断（管理员排障用） ----------
// 动机：排「内置浏览器挤进聊天区 / pane 右侧空白」这类显示
// 问题时，服务端看不到客户端画面，只能靠猜。诊断分两级：
//   layout（默认）：纯几何数字摘要（窗口/pane 宽度、原生页面
//     view 的摆位、版本），无任何内容——零隐私顾虑；
//   screenshot：另附整窗截图（含聊天内容）——仅在管理员
//     显式请求时采集，且目标用户必须在线。

/** 一条布局摘要：窗口几何 + 各 pane 宽度 + 原生浏览器 view 摆位。 */
export const DiagLayout = z.object({
  // 采集时刻。
  at: z.string(),
  // 客户端版本（package.json version）。
  app_version: z.string(),
  // 窗口视口（CSS px）与像素比（高 DPI 缩放核对用）。
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
  // 各 pane 当前宽度（未显示的 pane 为 null）。
  panes: z.object({
    sidebar: z.number().nullable(),
    viewer: z.number().nullable(),
    browser: z.number().nullable(),
    chat: z.number().nullable(),
  }),
  // 原生浏览器 view 的摆位（渲染端上报值）与浏览器 pane 的
  // DOM rect——两者脱节就是「页面盖到聊天上 / pane 露白」。
  // covered：采集时若有遮罩（管理对话框必然开着），
  // view 已被归零隐藏——view_posed=false 时 view 不在画面
  // 里，截图只见 stage 底色，bounds 只是「几何账面」。
  browser_view: z.object({
    open: z.boolean(),
    // 主进程侧最后收到的 rect（无上报为 null）。
    bounds: z
      .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
      .nullable(),
    // 采集瞬间 view 是否真的按 bounds 摆着（未被遮罩归零）。
    view_posed: z.boolean().optional(),
  }),
  browser_pane_rect: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullable(),
  // 主进程视角的屏幕真值（DPI 感知）。远程智能体问不出
  // 这些——wmic/注册表在高 DPI 下全是虚拟化值；
  // screen.getPrimaryDisplay() 的数字与渲染层 dpr 对账，
  // 缩放分叉一眼可判。旧客户端无此节（可选）。
  screen: z
    .object({
      // 屏幕物理像素 bounds 与 DIP 工作区。
      bounds: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      workArea: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      // Electron 认定的缩放系数——与 viewport.dpr 应一致。
      scaleFactor: z.number(),
      // 窗口内容区 DIP 尺寸（与 viewport.w/h 对账）。
      // 0.5.97 主进程曾发 [w,h] 数组（getContentSize 的
      // 裸返回），两种形状都收——采集数据不能白丢。
      contentSize: z
        .union([
          z.object({ width: z.number(), height: z.number() }),
          z.tuple([z.number(), z.number()]),
        ])
        .transform((v) =>
          Array.isArray(v) ? { width: v[0], height: v[1] } : v,
        )
        .nullable(),
    })
    .optional(),
});
export type DiagLayout = z.infer<typeof DiagLayout>;

export const DiagResult = z.object({
  request_id: z.string(),
  layout: DiagLayout,
  // screenshot scope 且采集成功时带整窗 PNG（base64）。
  screenshot: z
    .object({ media_type: z.string(), data: z.string() })
    .optional(),
});
export type DiagResult = z.infer<typeof DiagResult>;
