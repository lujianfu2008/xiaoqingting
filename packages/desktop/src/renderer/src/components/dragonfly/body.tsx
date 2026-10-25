// Body of the 小蜻蜓: wings, antennae, head, tail and the big compound eyes.

export function DragonflyBody(): React.JSX.Element {
  return (
    <>
      {/* wings — 4 blades pivoting at the thorax */}
      <g className="wingg wl1"><ellipse cx="54" cy="82" rx="48" ry="10.5" transform="rotate(-26 100 84)" fill="url(#dx-wing)" stroke="rgba(255,255,255,0.35)" strokeWidth="0.7" /></g>
      <g className="wingg wr1"><ellipse cx="146" cy="82" rx="48" ry="10.5" transform="rotate(26 100 84)" fill="url(#dx-wing)" stroke="rgba(255,255,255,0.35)" strokeWidth="0.7" /></g>
      <g className="wingg wl2"><ellipse cx="56" cy="92" rx="38" ry="8" transform="rotate(-8 100 84)" fill="url(#dx-wing)" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" /></g>
      <g className="wingg wr2"><ellipse cx="144" cy="92" rx="38" ry="8" transform="rotate(8 100 84)" fill="url(#dx-wing)" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" /></g>

      {/* antennae with cute tips */}
      <g className="antenna">
        <path d="M93 56 Q88 44 82 38" fill="none" stroke="#1f8f4e" strokeWidth="2" strokeLinecap="round" />
        <circle cx="82" cy="38" r="2.6" fill="#4ade80" />
      </g>
      <g className="antenna ant-r">
        <path d="M107 56 Q112 44 118 38" fill="none" stroke="#1f8f4e" strokeWidth="2" strokeLinecap="round" />
        <circle cx="118" cy="38" r="2.6" fill="#4ade80" />
      </g>

      {/* head + short chubby tail */}
      <circle cx="100" cy="66" r="11" fill="url(#dx-body)" />
      <ellipse cx="100" cy="90" rx="10.5" ry="12.5" fill="url(#dx-body)" />
      {/* energy core in the thorax */}
      <circle className="core" cx="100" cy="90" r="4" fill="#b8f1ff" />
      <rect x="96.2" y="100" width="7.6" height="42" rx="3.8" fill="url(#dx-body)" />
      <path d="M100 142 L104 162 L100 156.5 L96 162 Z" fill="#177a41" />
      {/* tail data-flow nodes */}
      <g className="tail-nodes">
        <circle className="tn tn1" cx="100" cy="108" r="2.6" />
        <circle className="tn tn2" cx="100" cy="118" r="2.4" />
        <circle className="tn tn3" cx="100" cy="128" r="2.2" />
        <circle className="tn tn4" cx="100" cy="138" r="2" />
        <circle className="tn tn5" cx="100" cy="149" r="1.8" />
      </g>
    </>
  );
}

export function DragonflyEyes(): React.JSX.Element {
  return (
    <>
      {/* compound eyes (big & cute) */}
      <circle className="dfly-eye eyeL" cx="78" cy="48" r="22" fill="url(#dx-eye)" />
      <circle className="dfly-eye eyeR" cx="122" cy="48" r="22" fill="url(#dx-eye)" />
      {/* state tint over the eyes */}
      <circle className="eye-tint" cx="78" cy="48" r="22" />
      <circle className="eye-tint" cx="122" cy="48" r="22" />

      {/* compound-eye data sparks */}
      <g className="gaze" clipPath="url(#dx-eyeL-clip)">
        <circle className="spark s1" cx="71" cy="41" r="3.4" fill="#eaffff" />
        <circle className="spark s2" cx="84" cy="52" r="2.3" fill="#ffffff" />
        <circle className="spark s3" cx="77" cy="57" r="1.8" fill="#d1f6ff" />
      </g>
      <g className="gaze" clipPath="url(#dx-eyeR-clip)">
        <circle className="spark s4" cx="129" cy="41" r="3.4" fill="#eaffff" />
        <circle className="spark s5" cx="116" cy="52" r="2.3" fill="#ffffff" />
        <circle className="spark s6" cx="122" cy="57" r="1.8" fill="#d1f6ff" />
      </g>

      {/* highlights + blinking eyelids */}
      <g clipPath="url(#dx-eyeL-clip)">
        <circle className="hl" cx="70" cy="40" r="3.6" fill="#ffffff" opacity="0.95" />
        <ellipse className="eyelid" cx="78" cy="26" rx="24" ry="24" fill="#0a3f63" />
      </g>
      <g clipPath="url(#dx-eyeR-clip)">
        <circle className="hl" cx="114" cy="40" r="3.6" fill="#ffffff" opacity="0.95" />
        <ellipse className="eyelid" cx="122" cy="26" rx="24" ry="24" fill="#0a3f63" />
      </g>
      {/* brows (sad / curious) */}
      <path className="brow browL" d="M66 22 Q78 18 88 24" fill="none" stroke="#0a3f63" strokeWidth="3" strokeLinecap="round" />
      <path className="brow browR" d="M112 24 Q122 18 134 22" fill="none" stroke="#0a3f63" strokeWidth="3" strokeLinecap="round" />
      <g fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.1">
        <circle cx="78" cy="48" r="22" />
        <circle cx="122" cy="48" r="22" />
      </g>
    </>
  );
}

// Mouth — one shape per emotion; the talking ellipse is animated while speaking.
export function DragonflyMouth({
  mouthRef,
}: {
  mouthRef: React.RefObject<SVGEllipseElement>;
}): React.JSX.Element {
  return (
    <g className="mouth">
      <ellipse ref={mouthRef} className="m-talk" cx="100" cy="77" rx="1.7" ry="1.1" fill="#0a3f63" />
      <path className="m-smile" d="M92 74 Q100 80 108 74" stroke="#0a3f63" strokeWidth="2.2" strokeLinecap="round" />
      <path className="m-frown" d="M92 78 Q100 72 108 78" stroke="#0a3f63" strokeWidth="2.2" strokeLinecap="round" />
      <circle className="m-oh" cx="100" cy="76" r="3.6" stroke="#0a3f63" strokeWidth="2" />
      <path className="m-flat" d="M94 76 L106 76" stroke="#0a3f63" strokeWidth="2.2" strokeLinecap="round" />
      <circle className="m-dot" cx="100" cy="76" r="1.4" fill="#0a3f63" />
    </g>
  );
}
