import { useStore } from "../../store";
import { useT } from "../../i18n";
import { DragonflyLogo, type DflyState } from "../DragonflyLogo";
import { DigitalHuman } from "../DigitalHuman";

// Sidebar hero: the avatar stage, the in-place avatar switcher and the status /
// stop-reading line underneath.
export function SidebarAvatar(): React.JSX.Element {
  const thinking = useStore((s) => Object.values(s.busy).some(Boolean));
  const speaking = useStore((s) => s.speaking);
  const expr = useStore((s) => s.expr);
  const avatarMode = useStore((s) => s.avatarMode);
  const setAvatarMode = useStore((s) => s.setAvatarMode);
  const stopSpeaking = useStore((s) => s.stopSpeaking);
  const recording = useStore((s) => s.recording);
  const t = useT();

  const dflyState: DflyState = recording
    ? "listening"
    : thinking
      ? "thinking"
      : speaking
        ? "speaking"
        : "idle";
  const statusLabel =
    dflyState === "thinking"
      ? t("av.thinking")
      : dflyState === "listening"
        ? t("av.listening")
        : dflyState === "speaking"
          ? t("av.speaking")
          : t("av.idle");
  const avatarName = avatarMode === "digitalhuman" ? t("av.dh") : t("av.dfly");
  const otherName = avatarMode === "digitalhuman" ? t("av.dfly") : t("av.dh");

  return (
    <div className={avatarMode === "digitalhuman" ? "dfly-hero dh-hero" : "dfly-hero"}>
      <button
        className="avatar-switch"
        title={t("av.switchTip", { cur: avatarName, other: otherName })}
        onClick={() => setAvatarMode(avatarMode === "digitalhuman" ? "dragonfly" : "digitalhuman")}
      >
        {t("av.switch")}
      </button>
      <div
        className={speaking ? "dfly-avatar clickable" : "dfly-avatar"}
        title={speaking ? t("av.stopTip") : t("av.idleTip", { cur: avatarName })}
        onClick={() => {
          if (speaking) stopSpeaking();
        }}
      >
        {avatarMode === "digitalhuman" ? (
          <DigitalHuman />
        ) : (
          <DragonflyLogo state={dflyState} expr={expr} active={thinking} />
        )}
      </div>
      {speaking ? (
        <button className="dfly-stop" onClick={stopSpeaking}>
          {t("av.stop")}
        </button>
      ) : (
        <div className="dfly-status">
          {avatarName} ·{" "}
          <span className={dflyState === "idle" ? undefined : "lit"}>{statusLabel}</span>
        </div>
      )}
    </div>
  );
}
