import { app, BrowserWindow, net } from "electron";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { safeSend } from "./safeSend";

// 语音模型按需下载：安装包不再内嵌 models/（省 ~83MB）。
// 模型 zip 放在服务端更新目录的 models/ 子目录（与安装包
// 同一个 /download/ 分发端点，白名单同源）。首次用语音时
// 下载解压到 userData/models/<name>/；也扫描本地目录兜底
// （离线机器手动放 zip/已解目录）。
//
// zip 解压用系统 PowerShell（Windows）/ unzip（Linux/mac）
// ——不引第三方 zip 依赖，模型 zip 都是扁平目录条目。

export type ModelName = "sherpa-paraformer" | "sherpa-kws";

export type ModelState = {
  name: ModelName;
  /** 已就绪（完整文件集都在）。 */
  ready: boolean;
  /** downloading = 下载中；error = 上次失败原因。 */
  phase: "idle" | "downloading" | "error";
  percent: number;
  error?: string;
};

const MODEL_NAMES: ModelName[] = ["sherpa-paraformer", "sherpa-kws"];

/** 各模型最小完整文件集（缺一个都不算就绪——历史坑：git 只跟踪
 * 了 tokens.txt，clone 出来的目录看似存在实则缺 onnx）。
 * `*.onnx` 表示「前缀 + 任意后缀 + .onnx」的通配（kws 文件名
 * 带 epoch 等版本后缀，与 wake.ts 的 pickOnnx 同规则）。 */
const MODEL_FILES: Record<ModelName, string[]> = {
  "sherpa-paraformer": ["tokens.txt", "model.int8.onnx", "am.mvn"],
  "sherpa-kws": ["tokens.txt", "encoder*.onnx", "decoder*.onnx", "joiner*.onnx"],
};

/** 完整性检查：精确项 existsSync，`*.onnx` 通配按前缀匹配。 */
function isComplete(name: ModelName, dir: string): boolean {
  let files: string[] | null = null;
  const has = (pat: string): boolean => {
    if (pat.endsWith("*.onnx")) {
      files ??= fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const prefix = pat.slice(0, -"*.onnx".length);
      return files.some((x) => x.startsWith(prefix) && x.endsWith(".onnx"));
    }
    return fs.existsSync(path.join(dir, pat));
  };
  return MODEL_FILES[name].every(has);
}

const state = new Map<ModelName, ModelState>();
MODEL_NAMES.forEach((n) => state.set(n, { name: n, ready: false, phase: "idle", percent: 0 }));

/** 重算 ready：解析实际生效目录（按需 → 打包 → dev）再验完整性，
 * dev/老版本自带模型的机器不必重复下载。 */
function checkReady(name: ModelName): boolean {
  return isComplete(name, modelDirOf(name));
}

// 启动时 + 每次取模型前都重扫一遍：用户手动补了文件要能被发现。
function modelRoot(): string {
  return path.join(app.getPath("userData"), "models");
}

/** dev: out/main -> packages/desktop/models（仓库内建好）。 */
function devModelRoot(): string {
  return path.join(__dirname, "../../models");
}

/** 取模型目录：按需目录 → 打包目录（老版本/手动放置）→ dev。
 * 完整性按文件集校验，半目录（如 git clone 只带 tokens.txt）
 * 不算命中，直接落到按需路径走下载补全。 */
export function modelDirOf(name: ModelName): string {
  const user = path.join(modelRoot(), name);
  if (isComplete(name, user)) return user;
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, "models", name);
    if (isComplete(name, packed)) return packed;
  } else {
    const dev = path.join(devModelRoot(), name);
    if (isComplete(name, dev)) return dev;
  }
  return user; // 未就绪时也返回按需路径（下载目标）
}

/** 推状态给所有窗口（设置面板语音区渲染下载进度）。 */
function push(name: ModelName): void {
  const st = state.get(name);
  if (!st) return;
  st.ready = checkReady(name);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) safeSend(win.webContents, "blm:models:state", st);
  }
}

/** 服务端模型包地址（renderer 登录后绑定，与 bindUpdater 同源）。 */
let baseUrl: string | null = null;

export function bindModelSource(serverUrl: string): void {
  baseUrl = `${serverUrl.replace(/\/+$/, "")}/download/models/`;
}

async function unzip(zipPath: string, dest: string): Promise<void> {
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  await fsp.mkdir(dest, { recursive: true });
  if (process.platform === "win32") {
    // -Path 可能带空格：execFile 数组传参不进 shell，无需引号。
    await new Promise<void>((res, rej) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive",
          "Expand-Archive", "-Force", "-Path", zipPath, "-DestinationPath", dest,
        ],
        (e: Error | null) => (e ? rej(e) : res()),
      );
    });
  } else {
    await new Promise<void>((res, rej) => {
      execFile("unzip", ["-o", zipPath, "-d", dest], (e: Error | null) =>
        e ? rej(e) : res(),
      );
    });
  }
}

const inflight = new Set<ModelName>();

/** 下载（若已在下/已就绪则直接返回状态）。 */
export async function downloadModel(name: ModelName): Promise<ModelState> {
  const st = state.get(name)!;
  if (checkReady(name)) {
    st.ready = true; st.phase = "idle"; st.percent = 100; push(name);
    return { ...st };
  }
  if (!baseUrl) {
    st.phase = "error";
    st.error = "尚未连接服务器，无法下载模型";
    push(name);
    return { ...st };
  }
  if (inflight.has(name)) return { ...st };

  inflight.add(name);
  st.phase = "downloading";
  st.error = undefined;
  st.percent = 0;
  push(name);
  const zipPath = path.join(app.getPath("temp"), `${name}.zip`);
  try {
    await fsp.mkdir(path.dirname(zipPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      // Chromium 网络栈：跟随系统代理，与更新下载同一链路。
      const req = net.request({ url: `${baseUrl}${name}.zip`, redirect: "follow" });
      let size = 0;
      let got = 0;
      const file = fs.createWriteStream(zipPath);
      const fail = (e: Error): void => {
        try { req.abort(); } catch { /* 已完成无妨 */ }
        file.close(() => reject(e));
      };
      req.on("response", (res) => {
        if (res.statusCode !== 200) {
          fail(new Error(`下载失败（HTTP ${res.statusCode}）`));
          return;
        }
        const len = res.headers["content-length"];
        size = len ? Number(len) : 0;
        res.on("data", (chunk: Uint8Array) => {
          got += chunk.length;
          file.write(Buffer.from(chunk));
          if (size > 0) {
            const pct = Math.min(99, Math.round((got / size) * 100));
            if (pct - st.percent >= 3) {
              st.percent = pct;
              push(name);
            }
          }
        });
        res.on("end", () => {
          file.end(() => {
            if (size === 0 || got >= size) resolve();
            else fail(new Error("下载不完整"));
          });
        });
        res.on("error", (e: Error) => fail(e));
      });
      req.on("error", (e: Error) => fail(e));
      req.end();
    });
    // 解压到用户目录（zip 内已含目录前缀 sherpa-xxx/…，也可能
    // 扁平——两种都兜住）。绝不解进打包目录：Program Files
    // 需要管理员权限，写那里在多数机器上会失败。
    const dest = path.join(modelRoot(), name);
    await unzip(zipPath, dest);
    // zip 里若带了一层目录名（sherpa-paraformer/…），展开后
    // tokens.txt 在子目录里：把内层文件搬上来。
    if (!fs.existsSync(path.join(dest, "tokens.txt"))) {
      const inner = fs
        .readdirSync(dest, { withFileTypes: true })
        .find((d) => d.isDirectory() && fs.existsSync(path.join(dest, d.name, "tokens.txt")));
      if (inner) {
        const from = path.join(dest, inner.name);
        for (const f of fs.readdirSync(from)) {
          fs.renameSync(path.join(from, f), path.join(dest, f));
        }
        fs.rmSync(path.join(dest, inner.name), { recursive: true, force: true });
      }
    }
    if (!isComplete(name, dest)) {
      throw new Error("解压后模型不完整（缺文件）");
    }
    st.phase = "idle";
    st.percent = 100;
    st.ready = true;
  } catch (e) {
    st.phase = "error";
    st.error = e instanceof Error ? e.message : "模型下载失败";
    st.percent = 0;
    // 半成品清掉，下次重来。
    fs.rm(zipPath, { force: true }, () => undefined);
  } finally {
    inflight.delete(name);
    push(name);
  }
  return { ...state.get(name)! };
}

/** 全量状态（设置面板播种）。 */
export function modelsState(): ModelState[] {
  return MODEL_NAMES.map((n) => {
    const st = state.get(n)!;
    st.ready = checkReady(n);
    return { ...st };
  });
}

/** 模块启动时先把 dev/打包目录里的旧模型登记为已就绪。 */
export function seedModelStates(): void {
  MODEL_NAMES.forEach((n) => {
    state.get(n)!.ready = checkReady(n);
  });
}
