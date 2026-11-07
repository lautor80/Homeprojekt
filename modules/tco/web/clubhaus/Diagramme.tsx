/** Kleine SVG-Diagramme wie in der SAP-App (Säulen + Linie), ohne Zusatzbibliothek */

const BAR = 'var(--sapChart_OrderedColor_1, #0070F2)';
const LINE = 'var(--sapChart_OrderedColor_2, #E76500)';
const GRID = 'var(--sapList_BorderColor, #D5DAE0)';
const TEXT = 'var(--sapContent_LabelColor, #556B82)';
const fmt = (v: number, d = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Einnahmen je Monat (Säulen) und offene Posten (Linie) auf einer gemeinsamen EUR-Achse */
export function EinnahmenDiagramm({ punkte }: { punkte: { label: string; einnahme: number; op: number }[] }) {
  if (!punkte.length) return null;
  const xl = 70, xr = 580, top = 60, base = 385;
  const werte = punkte.flatMap((p) => [p.einnahme, p.op, 0]);
  let max = Math.max(...werte) * 1.15, min = Math.min(...werte) * 1.15;
  if (max === min) max = 1;
  const range = max - min, h = base - top, slot = (xr - xl) / punkte.length, bw = slot * 0.55;
  const y = (v: number) => base - (h * (v - min)) / range;
  const y0 = y(0);
  return (
    <svg viewBox="0 0 600 420" style={{ width: '100%', maxWidth: 640 }} fontFamily="var(--sapFontFamily)">
      <rect x={xl} y={17} width={12} height={12} rx={2} fill={BAR} />
      <text x={xl + 18} y={28} fontSize={14} fontWeight="bold" fill={BAR}>Einnahmen je Monat</text>
      <line x1={300} y1={23} x2={324} y2={23} stroke={LINE} strokeWidth={3} />
      <circle cx={312} cy={23} r={4} fill="#fff" stroke={LINE} strokeWidth={2.5} />
      <text x={332} y={28} fontSize={14} fontWeight="bold" fill={LINE}>Offene Posten</text>
      <text x={xr} y={28} fontSize={11} textAnchor="end" fill={TEXT}>EUR</text>
      {[0, 1, 2, 3, 4].map((k) => {
        const v = min + (range * k) / 4, ty = base - (h * k) / 4;
        return <g key={k}><line x1={xl} y1={ty} x2={xr} y2={ty} stroke={GRID} /><text x={xl - 8} y={ty + 4} fontSize={11} textAnchor="end" fill={TEXT}>{fmt(v)}</text></g>;
      })}
      {punkte.map((p, i) => {
        const cx = xl + slot * i + slot / 2, ey = y(p.einnahme);
        return (
          <g key={i}>
            {p.einnahme !== 0 && <>
              <rect x={cx - bw / 2} y={Math.min(ey, y0)} width={bw} height={Math.abs(ey - y0)} rx={2} fill={BAR} />
              <text x={cx} y={p.einnahme > 0 ? ey - 6 : ey + 14} fontSize={10} textAnchor="middle" fill={TEXT}>{fmt(p.einnahme)}</text>
            </>}
            <text x={cx} y={406} fontSize={12} textAnchor="middle" fill={TEXT}>{p.label}</text>
          </g>
        );
      })}
      <line x1={xl} y1={y0} x2={xr} y2={y0} stroke={TEXT} />
      <polyline points={punkte.map((p, i) => `${xl + slot * i + slot / 2},${y(p.op)}`).join(' ')} fill="none" stroke={LINE} strokeWidth={3} strokeLinejoin="round" />
      {punkte.map((p, i) => {
        const cx = xl + slot * i + slot / 2;
        return <g key={i}><circle cx={cx} cy={y(p.op)} r={4} fill="#fff" stroke={LINE} strokeWidth={2.5} /><text x={cx} y={y(p.op) - 10} fontSize={10} textAnchor="middle" fill={LINE}>{fmt(p.op)}</text></g>;
      })}
    </svg>
  );
}

/** Absatz je Jahr (Säulen oben) und durchschnittlicher EK-Preis (Linie unten) */
export function AbsatzDiagramm({ punkte, einheit }: { punkte: { jahr: number; menge: number; preis: number }[]; einheit: 'Kisten' | 'Flaschen' }) {
  if (!punkte.length) return null;
  const xl = 70, xr = 580, p1t = 48, p1b = 215, p2t = 282, p2b = 385;
  const maxM = Math.max(...punkte.map((p) => p.menge), 0) * 1.15 || 1;
  const maxP = Math.max(...punkte.map((p) => p.preis), 0) * 1.25 || 1;
  const slot = (xr - xl) / punkte.length, bw = Math.min(slot * 0.42, 70);
  const cx = (i: number) => xl + slot * i + slot / 2;
  const py = (v: number) => p2b - ((p2b - p2t) * v) / maxP;
  return (
    <svg viewBox="0 0 600 420" style={{ width: '100%', maxWidth: 640 }} fontFamily="var(--sapFontFamily)">
      <text x={xl} y={28} fontSize={14} fontWeight="bold" fill={BAR}>Absatz in {einheit}</text>
      {[0, 1, 2].map((k) => { const ty = p1b - ((p1b - p1t) * k) / 2; return <g key={k}><line x1={xl} y1={ty} x2={xr} y2={ty} stroke={GRID} /><text x={xl - 10} y={ty + 4} fontSize={11} textAnchor="end" fill={TEXT}>{fmt((maxM * k) / 2)}</text></g>; })}
      <text x={xl} y={262} fontSize={14} fontWeight="bold" fill={LINE}>EK-Preis Durchschnitt je {einheit === 'Kisten' ? 'Kiste' : 'Flasche'} (EUR)</text>
      {[0, 1, 2].map((k) => { const ty = p2b - ((p2b - p2t) * k) / 2; return <g key={k}><line x1={xl} y1={ty} x2={xr} y2={ty} stroke={GRID} /><text x={xl - 10} y={ty + 4} fontSize={11} textAnchor="end" fill={TEXT}>{fmt((maxP * k) / 2, 2)}</text></g>; })}
      {punkte.map((p, i) => {
        const bh = ((p1b - p1t) * p.menge) / maxM;
        return (
          <g key={p.jahr}>
            <rect x={cx(i) - bw / 2} y={p1b - bh} width={bw} height={bh} rx={2} fill={BAR} />
            <text x={cx(i)} y={p1b - bh - 8} fontSize={12} textAnchor="middle" fill={TEXT}>{fmt(p.menge)}</text>
            <text x={cx(i)} y={406} fontSize={13} textAnchor="middle" fill={TEXT}>{p.jahr}</text>
          </g>
        );
      })}
      <polyline points={punkte.map((p, i) => `${cx(i)},${py(p.preis)}`).join(' ')} fill="none" stroke={LINE} strokeWidth={3} strokeLinejoin="round" />
      {punkte.map((p, i) => <g key={p.jahr}><circle cx={cx(i)} cy={py(p.preis)} r={5} fill="#fff" stroke={LINE} strokeWidth={3} /><text x={cx(i)} y={py(p.preis) - 13} fontSize={12} textAnchor="middle" fill={LINE}>{fmt(p.preis, 2)}</text></g>)}
      <line x1={xl} y1={p1b} x2={xr} y2={p1b} stroke={TEXT} />
      <line x1={xl} y1={p2b} x2={xr} y2={p2b} stroke={TEXT} />
    </svg>
  );
}
