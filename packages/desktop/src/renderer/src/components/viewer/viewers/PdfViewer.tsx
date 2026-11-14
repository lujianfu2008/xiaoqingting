import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import type { ViewerProps } from "../../viewer/registry";
import { toViewerUrl } from "../toViewerUrl";

// PDF viewer（pdfjs-dist）：worker 用 vite 的 ?worker&inline
// 打进 bundle（prod file:// 下跨源 worker 不可用，inline 是唯一
// 稳的方式）。逐页渲染到 canvas，页数多时按 5 页一批展示。
// 文件数据走 viewer:// 协议流；初始化失败（损坏文件等）
// 回退提示 + 系统打开。

import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";

let pdfjsReady: Promise<typeof import("pdfjs-dist")> | null = null;
function getPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsReady) {
    pdfjsReady = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
      return pdfjs;
    });
  }
  return pdfjsReady;
}

const PAGE_INC = 5;

export default function PdfViewer({ path }: ViewerProps): React.JSX.Element {
  const t = useT();
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const docRef = useRef<Awaited<
    ReturnType<typeof getPdfjs>
  > extends never ? never : import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setTotal(0);
    setPages(0);
    setFailed(null);
    void (async () => {
      try {
        const pdfjs = await getPdfjs();
        const doc = await pdfjs.getDocument({
          url: toViewerUrl(path),
          isEvalSupported: false,
        }).promise;
        if (!alive) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setTotal(doc.numPages);
        setPages(Math.min(PAGE_INC, doc.numPages));
      } catch (e) {
        if (alive) setFailed((e as Error).message);
      }
    })();
    return () => {
      alive = false;
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, [path]);

  // 渲染 page 1..pages 到 canvas（重渲染时复用已有 canvas）。
  useEffect(() => {
    const host = hostRef.current;
    const doc = docRef.current;
    if (!host || !doc || pages === 0) return;
    let alive = true;
    void (async () => {
      for (let i = 1; i <= pages; i++) {
        if (!alive) return;
        const page = await doc.getPage(i);
        const scale = 1.5;
        const vp = page.getViewport({ scale });
        let canvas = host.querySelector<HTMLCanvasElement>(`canvas[data-page="${i}"]`);
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.dataset.page = String(i);
          host.appendChild(canvas);
        }
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.maxWidth = "100%";
        await page.render({
          canvasContext: canvas.getContext("2d")!,
          viewport: vp,
        }).promise;
      }
    })();
    return () => {
      alive = false;
    };
  }, [pages, total]);

  if (failed) {
    return (
      <div className="viewer-status">
        {t("vw.loadFail")}
        <button onClick={() => void window.blm.viewer.openExternal(path)}>
          {t("vw.openExternal")}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="viewer-truncated">
        {total > 0 ? t("vw.pdfPages", { shown: pages, total }) : t("vw.loading")}
        {pages < total && (
          <button onClick={() => setPages((p) => Math.min(p + PAGE_INC, total))}>
            {t("vw.pdfMore")}
          </button>
        )}
      </div>
      <div className="viewer-pdf" ref={hostRef} />
    </>
  );
}
