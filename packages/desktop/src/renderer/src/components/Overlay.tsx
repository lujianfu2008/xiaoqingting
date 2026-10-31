import { useRef } from "react";

/**
 * Fullscreen modal overlay that closes on a *deliberate* outside click only:
 * both the press and the release must land on the overlay itself. Dragging
 * out of the dialog (text selection, native <select> popups) or releasing a
 * stray mouseup over the overlay no longer dismisses the dialog — losing a
 * half-filled settings form to an accidental click was the point of this.
 *
 * `closeOnOutside={false}` disables outside-click dismissal entirely (the
 * dialog then closes only through its own buttons).
 */
export function Overlay({
  onClose,
  children,
  closeOnOutside = true,
}: {
  onClose: () => void;
  children: React.ReactNode;
  closeOnOutside?: boolean;
}): React.JSX.Element {
  const armed = useRef(false);
  return (
    <div
      className="overlay"
      onMouseDown={
        closeOnOutside
          ? (e) => {
              armed.current = e.target === e.currentTarget;
            }
          : undefined
      }
      onClick={
        closeOnOutside
          ? (e) => {
              if (armed.current && e.target === e.currentTarget) onClose();
              armed.current = false;
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
