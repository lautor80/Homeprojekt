/** SVG-Diagramme der Mitglieder-Analyse (Säulen, Balken, Gruppensäulen) ohne Zusatzbibliothek, Farben aus dem Theme */

const C1 = 'var(--sapChart_OrderedColor_1, #0070F2)';
const C2 = 'var(--sapChart_OrderedColor_2, #E76500)';
const C3 = 'var(--sapChart_OrderedColor_3, #188918)';
const GRID = 'var(--sapList_BorderColor, #D5DAE0)';
const TEXT = 'var(--sapContent_LabelColor, #556B82)';
const WERT = 'var(--sapTextColor, #1D2D3E)';
const FONT = 'var(--sapFontFamily)';
const fmt = (v: number, d = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Rasterlinien und Achsenbeschriftung für eine Werteachse von 0 bis max */
function schritte(max: number, n = 4): number[] {
  const roh = max / n;
  const pot = 10 ** Math.floor(Math.log10(roh || 1));
  const s = [1, 2, 2.5, 5, 10].map((x) => x * pot).find((x) => x >= roh) ?? pot;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += s) out.push(v);
  return out;
}

/** Säulen: ein Wert je Rubrik (Altersgruppen, Geschlecht) */
export function Saeulen({ punkte, farbe = C1, hoehe = 300 }: { punkte: { label: string; wert: number }[]; farbe?: string; hoehe?: number }) {
  if (!punkte.length) return null;
  const xl = 56, xr = 590, top = 24, base = hoehe - 48;
  const rohMax = Math.max(...punkte.map((p) => p.wert), 0);
  const st = schritte(rohMax || 1);
  const max = st[st.length - 1] || 1;
  const h = base - top, slot = (xr - xl) / punkte.length, bw = Math.min(slot * 0.6, 90);
  const y = (v: number) => base - (h * v) / max;
  return (
    <svg viewBox={`0 0 600 ${hoehe}`} style={{ width: '100%' }} fontFamily={FONT} role="img">
      {st.map((v) => <g key={v}><line x1={xl} y1={y(v)} x2={xr} y2={y(v)} stroke={GRID} /><text x={xl - 8} y={y(v) + 4} fontSize={11} textAnchor="end" fill={TEXT}>{fmt(v)}</text></g>)}
      {punkte.map((p, i) => {
        const cx = xl + slot * i + slot / 2;
        return (
          <g key={p.label}>
            {p.wert > 0 && <rect x={cx - bw / 2} y={y(p.wert)} width={bw} height={base - y(p.wert)} rx={2} fill={farbe} />}
            <text x={cx} y={y(p.wert) - 6} fontSize={12} fontWeight="bold" textAnchor="middle" fill={WERT}>{fmt(p.wert)}</text>
            <text x={cx} y={base + 18} fontSize={11} textAnchor="middle" fill={TEXT}>{p.label}</text>
          </g>
        );
      })}
      <line x1={xl} y1={base} x2={xr} y2={base} stroke={TEXT} />
    </svg>
  );
}

/** Waagerechte Balken mit Beschriftung links (Vertragsarten, Orte) */
export function Balken({ punkte, farbe = C1 }: { punkte: { label: string; wert: number; zusatz?: string }[]; farbe?: string }) {
  if (!punkte.length) return null;
  const zeile = 30, xl = 190, xr = 560, top = 10;
  const hoehe = top + punkte.length * zeile + 10;
  const max = Math.max(...punkte.map((p) => p.wert), 0) || 1;
  const w = (v: number) => ((xr - xl) * v) / max;
  return (
    <svg viewBox={`0 0 600 ${hoehe}`} style={{ width: '100%' }} fontFamily={FONT} role="img">
      {punkte.map((p, i) => {
        const y = top + i * zeile;
        const l = p.label.length > 28 ? `${p.label.slice(0, 27)}…` : p.label;
        return (
          <g key={p.label}>
            <text x={xl - 10} y={y + 19} fontSize={12} textAnchor="end" fill={WERT}>{l}</text>
            <rect x={xl} y={y + 6} width={Math.max(w(p.wert), 1)} height={18} rx={2} fill={farbe} />
            <text x={xl + w(p.wert) + 6} y={y + 19} fontSize={12} fontWeight="bold" fill={WERT}>{fmt(p.wert)}{p.zusatz ? <tspan fontWeight="normal" fill={TEXT}> {p.zusatz}</tspan> : null}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Eintritte und Austritte je Jahr als Säulenpaare */
export function EinAustritte({ punkte }: { punkte: { jahr: number; eintritte: number; austritte: number }[] }) {
  if (!punkte.length) return null;
  const hoehe = 320, xl = 56, xr = 590, top = 40, base = hoehe - 44;
  const rohMax = Math.max(...punkte.flatMap((p) => [p.eintritte, p.austritte]), 0);
  const st = schritte(rohMax || 1);
  const max = st[st.length - 1] || 1;
  const h = base - top, slot = (xr - xl) / punkte.length, bw = Math.min(slot * 0.36, 40);
  const y = (v: number) => base - (h * v) / max;
  return (
    <svg viewBox={`0 0 600 ${hoehe}`} style={{ width: '100%' }} fontFamily={FONT} role="img">
      <rect x={xl} y={10} width={12} height={12} rx={2} fill={C3} />
      <text x={xl + 18} y={21} fontSize={13} fontWeight="bold" fill={C3}>Eintritte</text>
      <rect x={xl + 110} y={10} width={12} height={12} rx={2} fill={C2} />
      <text x={xl + 128} y={21} fontSize={13} fontWeight="bold" fill={C2}>Austritte</text>
      {st.map((v) => <g key={v}><line x1={xl} y1={y(v)} x2={xr} y2={y(v)} stroke={GRID} /><text x={xl - 8} y={y(v) + 4} fontSize={11} textAnchor="end" fill={TEXT}>{fmt(v)}</text></g>)}
      {punkte.map((p, i) => {
        const cx = xl + slot * i + slot / 2;
        return (
          <g key={p.jahr}>
            {p.eintritte > 0 && <rect x={cx - bw - 1} y={y(p.eintritte)} width={bw} height={base - y(p.eintritte)} rx={2} fill={C3} />}
            {p.eintritte > 0 && <text x={cx - bw / 2 - 1} y={y(p.eintritte) - 4} fontSize={10} textAnchor="middle" fill={WERT}>{fmt(p.eintritte)}</text>}
            {p.austritte > 0 && <rect x={cx + 1} y={y(p.austritte)} width={bw} height={base - y(p.austritte)} rx={2} fill={C2} />}
            {p.austritte > 0 && <text x={cx + bw / 2 + 1} y={y(p.austritte) - 4} fontSize={10} textAnchor="middle" fill={WERT}>{fmt(p.austritte)}</text>}
            <text x={cx} y={base + 18} fontSize={11} textAnchor="middle" fill={TEXT}>{p.jahr}</text>
          </g>
        );
      })}
      <line x1={xl} y1={base} x2={xr} y2={base} stroke={TEXT} />
    </svg>
  );
}
