import { useRef } from "react";
import { useT } from "../i18n";

// Splitter between two panes. "col" (default): vertical bar, drag left/right
// to resize widths; "row": horizontal bar, drag up/down to resize heights.
// Double-click restores the default. Pointer capture keeps the drag alive
// while the cursor outruns the pane edge (important over the native browser
// view, which paints above the renderer).
export function Splitter(props: {
  orientation?: "col" | "row";
  onDrag(pos: number): void;
  onReset(): void;
  onDragChange?(dragging: boolean): void;
  label: string;
}): React.JSX.Element {
  const active = useRef(false);
  const row = props.orientation === "row";
  const t = useT();
  const end = (el: HTMLElement, pointerId: number): void => {
    if (!active.current) return;
    active.current = false;
    el.classList.remove("active");
    document.body.classList.remove("resizing");
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    props.onDragChange?.(false);
  };

  return (
    <div
      className={`splitter ${row ? "row" : ""}`}
      role="separator"
      aria-orientation={row ? "horizontal" : "vertical"}
      aria-label={props.label}
      title={row ? t("pane.dragH") : t("pane.dragW")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        active.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add("active");
        // Without this the drag selects text and the cursor flickers.
        document.body.classList.add("resizing");
        props.onDragChange?.(true);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (active.current) props.onDrag(row ? e.clientY : e.clientX);
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={props.onReset}
    />
  );
}
