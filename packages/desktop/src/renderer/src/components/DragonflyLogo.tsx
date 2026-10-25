// 小蜻蜓 — stateful, cartoonish, sci-fi dragonfly avatar.
// state:    "idle" | "thinking" | "speaking" | "listening"  (what the agent is doing)
// expr:     "normal" | "happy" | "sad" | "surprised" | "curious" | "serious"
//           (emotion of the latest reply, from the server's emotion tag)
//
// Pure SVG + CSS: rotating halo ring, orbiting particles, blinking eyelids,
// a tiny mouth (real lip-sync from the TTS audio while speaking), tail
// data-flow lights, hover excitement, press-to-wiggle. No images.
//
// Geometry lives in ./dragonfly/{parts,body}.tsx; this file owns the animation
// loop and the public exports.

import { useEffect, useRef } from "react";
import { readLipSync } from "../speech";
import type { DflyExpr, DflyState } from "./dragonfly/expr";
import { DragonflyAura, DragonflyDefs } from "./dragonfly/parts";
import { DragonflyBody, DragonflyEyes, DragonflyMouth } from "./dragonfly/body";

export type { DflyState, DflyExpr };
export { normalizeExpr, EXPR_VALUES } from "./dragonfly/expr";

export function DragonflyLogo({
  state = "idle",
  expr = "normal",
  active = false,
  size,
}: {
  state?: DflyState;
  expr?: DflyExpr;
  active?: boolean;
  size?: number;
}): React.JSX.Element {
  const st: DflyState = active ? "thinking" : state;
  const mouthRef = useRef<SVGEllipseElement>(null);

  // Real lip-sync while speaking: the mouth ellipse is resized from the live
  // audio spectrum (same source as the 3D avatar).
  useEffect(() => {
    if (st !== "speaking") return;
    let raf = 0;
    const step = (): void => {
      raf = requestAnimationFrame(step);
      const el = mouthRef.current;
      if (!el) return;
      const lip = readLipSync();
      const open = Math.max(lip.aa, lip.ou * 0.9, lip.oh * 0.85, lip.ee * 0.7);
      el.setAttribute("ry", (1.1 + open * 3.2).toFixed(2));
      el.setAttribute("rx", (1.7 + lip.level * 1.5).toFixed(2));
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [st]);

  return (
    <svg
      className={`dfly st-${st} ex-${expr}`}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      preserveAspectRatio="xMidYMid meet"
      aria-label="小蜻蜓"
      role="img"
    >
      <DragonflyDefs />
      <DragonflyAura />

      <g className="dfly-all">
        <DragonflyBody />
        <DragonflyEyes />
        <DragonflyMouth mouthRef={mouthRef} />
      </g>
    </svg>
  );
}
