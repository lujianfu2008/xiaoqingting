// Static SVG parts of the 小蜻蜓 avatar. The wrapper (DragonflyLogo) owns the
// classes that animate them; these pieces only carry geometry.

export function DragonflyDefs(): React.JSX.Element {
  return (
    <defs>
      <radialGradient id="dx-eye" cx="35%" cy="30%" r="82%">
        <stop offset="0%" stopColor="#c4f4ff" />
        <stop offset="48%" stopColor="#2e9fd8" />
        <stop offset="100%" stopColor="#0a3f63" />
      </radialGradient>
      <linearGradient id="dx-wing" x1="100%" y1="0%" x2="0%" y2="60%">
        <stop offset="0%" stopColor="rgba(160,230,255,0.08)" />
        <stop offset="55%" stopColor="rgba(140,220,255,0.36)" />
        <stop offset="100%" stopColor="rgba(205,247,255,0.55)" />
      </linearGradient>
      <linearGradient id="dx-body" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#2fbf6a" />
        <stop offset="100%" stopColor="#177a41" />
      </linearGradient>
      <clipPath id="dx-eyeL-clip">
        <circle cx="78" cy="48" r="22" />
      </clipPath>
      <clipPath id="dx-eyeR-clip">
        <circle cx="122" cy="48" r="22" />
      </clipPath>
    </defs>
  );
}

// Rotating magic array + orbiting particles + speaking sound waves.
export function DragonflyAura(): React.JSX.Element {
  return (
    <>
      <g className="dfly-halo">
        <circle className="halo-ring" cx="100" cy="72" r="76" />
        <circle className="halo-ring2" cx="100" cy="72" r="66" />
        <g className="halo-ticks">
          {Array.from({ length: 12 }).map((_, i) => {
            const a = (i * 30 * Math.PI) / 180;
            const x1 = 100 + Math.cos(a) * 70;
            const y1 = 72 + Math.sin(a) * 70;
            const x2 = 100 + Math.cos(a) * 76;
            const y2 = 72 + Math.sin(a) * 76;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
      </g>

      {/* sound waves — visible only while speaking */}
      <g className="dfly-waves">
        <circle className="wave wv1" cx="100" cy="48" r="26" />
        <circle className="wave wv2" cx="100" cy="48" r="36" />
        <circle className="wave wv3" cx="100" cy="48" r="46" />
      </g>

      {/* orbiting particles */}
      <g className="dfly-orbit">
        <circle className="orb orb1" cx="100" cy="6" r="3.4" />
        <circle className="orb orb2" cx="194" cy="72" r="2.6" />
      </g>
    </>
  );
}
