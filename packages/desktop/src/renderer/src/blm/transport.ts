// blmCompat 传输层：Android WebView 壳（packages/mobile-android）里
// 注入的 BlmBridge 只暴露一个通用 RPC 入口 ——
//   window.BlmAndroidBridge.invoke(callId, method, argsJson)
//   window.BlmAndroidBridge.bridgeInfo()
// 同步受理、异步经 window.__blmResolve(callId, ok, resultJson) 回执；
// 原生事件经 window.__blmEvent(name, payloadJson) 下发。
// 桌面端 preload 先于页面脚本注入 window.blm，本文件整段不会被
// 触发（install.ts 提前 return），桌面行为零变化。

// addJavascriptInterface 只能同步返回基础类型，JSON 全走字符串。
interface BridgeInfo {
  kind: string;
  app_version?: string;
}

interface BlmAndroidBridge {
  invoke(callId: string, method: string, argsJson: string): string;
  bridgeInfo(): string;
}

// 壳回注的两个 window 函数（Kotlin evaluateJavascript 调用）。
declare global {
  interface Window {
    __blmResolve?: (callId: string, ok: boolean, resultJson: string) => void;
    __blmEvent?: (name: string, payloadJson: string) => void;
  }
}

let seq = 0;

function nextCallId(): string {
  seq = (seq + 1) % 1_000_000;
  return `c${Date.now().toString(36)}${seq}`;
}

/** 原生桥对象（Android 壳注入；桌面不存在）。 */
export function nativeBridge(): BlmAndroidBridge | null {
  const b = (window as unknown as Record<string, unknown>).BlmAndroidBridge;
  return typeof b === "object" && b !== null ? (b as BlmAndroidBridge) : null;
}

/** 探测壳环境信息（kind=android 才启用 compat）。 */
export function probeBridgeInfo(): BridgeInfo | null {
  const b = nativeBridge();
  if (!b) return null;
  try {
    return JSON.parse(b.bridgeInfo()) as BridgeInfo;
  } catch {
    return null;
  }
}

type Resolve = (ok: boolean, resultJson: string) => void;

const pending = new Map<string, Resolve>();

// 回执入口：壳在页面加载前注入，事件可能在订阅前发生，
// 用 window 函数而非模块级变量，避免双实例（HMR）丢引用。
if (typeof window.__blmResolve !== "function") {
  window.__blmResolve = (callId: string, ok: boolean, resultJson: string): void => {
    const r = pending.get(callId);
    if (!r) return; // 早已超时/卸载
    pending.delete(callId);
    try {
      r(ok, resultJson);
    } catch {
      // 回调抛错不反噬桥
    }
  };
}
if (typeof window.__blmEvent !== "function") {
  window.__blmEvent = (name: string, payloadJson: string): void => {
    const subs = events.get(name);
    if (!subs) return;
    let payload: unknown = null;
    try {
      payload = payloadJson === "" ? null : JSON.parse(payloadJson);
    } catch {
      payload = null;
    }
    for (const cb of [...subs]) {
      try {
        cb(payload);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  };
}

const events = new Map<string, Set<(payload: unknown) => void>>();

/** 订阅原生事件（onXxx(cb) 的底座）；返回退订函数。 */
export function subscribeEvent(
  name: string,
  cb: (payload: unknown) => void,
): () => void {
  let set = events.get(name);
  if (!set) {
    set = new Set();
    events.set(name, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export class RpcError extends Error {}

/** 调一个原生方法；reject 携带反序列化后的错误对象。 */
export function call<T>(method: string, args?: unknown): Promise<T> {
  const b = nativeBridge();
  if (!b) {
    return Promise.reject(new RpcError("blm bridge unavailable"));
  }
  const callId = nextCallId();
  // callId 同时塞进参数对象：Kotlin 能力模块回执时
  // 直接读 __callId（dispatch 第二参只经日志可见）。
  const argsJson =
    args === undefined
      ? JSON.stringify({ __callId: callId })
      : JSON.stringify({ __callId: callId, ...(args as Record<string, unknown>) });
  return new Promise<T>((resolve, reject) => {
    pending.set(callId, (ok, resultJson) => {
      if (!ok) {
        let err: unknown = null;
        try {
          err = JSON.parse(resultJson);
        } catch {
          err = null;
        }
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "error" in err
              ? String((err as { error: unknown }).error)
              : resultJson || "blm call failed";
        reject(new RpcError(msg));
        return;
      }
      let v: unknown = null;
      try {
        v = resultJson === "" ? null : JSON.parse(resultJson);
      } catch {
        v = null;
      }
      resolve(v as T);
    });
    // invoke 同步受理；返回值只报「未受理」（桥忙/方法未知）。
    let accepted = false;
    try {
      accepted = b.invoke(callId, method, argsJson) === "true";
    } catch (e) {
      pending.delete(callId);
      reject(e instanceof Error ? e : new RpcError(String(e)));
      return;
    }
    if (!accepted) {
      pending.delete(callId);
      reject(new RpcError(`blm method rejected: ${method}`));
    }
  });
}

const BLOB_CHUNK = 256 * 1024;

/**
 * 把二进制上传成原生 blob（大 payload 不进 JSON）。
 * 每块 base64 分片，原生侧拼装；返回 blob 引用 id。
 */
export async function blobPut(bytes: Uint8Array): Promise<string> {
  const total = bytes.length;
  let id = "";
  for (let off = 0; off < Math.max(total, 1); off += BLOB_CHUNK) {
    const end = Math.min(off + BLOB_CHUNK, total);
    const slice = bytes.subarray(off, end);
    let b64: string;
    try {
      b64 = base64FromBytes(slice);
    } catch {
      throw new RpcError("blob encode failed");
    }
    const last = end >= total;
    const r = await call<{ id?: string; error?: string }>("blob.append", {
      id,
      data: b64,
      final: last,
      total,
    });
    if (r.error || !r.id) throw new RpcError(r.error ?? "blob.append failed");
    id = r.id;
  }
  return id;
}

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
