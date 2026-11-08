/** Säulendiagramm Basisjahr gegen Forecast je Monat – wie BUILD_BARS_SVG der SAP-App, ohne Zusatzbibliothek */

const C1 = 'var(--sapChart_OrderedColor_1, #0070F2)';
const C2 = 'var(--sapChart_OrderedColor_2, #E76500)';
const GRID = 'var(--sapList_BorderColor, #D5DAE0)';
const TEXT = 'var(--sapContent_LabelColor, #556B82)';
const TITLE = 'var(--sapTextColor, #32363A)';

/** Achsenbeschriftung kurz: 1.250 → „1,3k“ */
const kurz = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : v.toLocaleString('de-DE', { maximumFractionDigits: 0 }));

export interface Punkt { label: string; val1: number; val2: number }

export function BalkenDiagramm({ titel, name1, name2, punkte }: { titel: string; name1: string; name2: string; punkte: Punkt[] }) {
  if (!punkte.length) return null;
  const w = 800, h = 300, ml = 66, mr = 20, mt = 52, mb = 40;
  const pw = w - ml - mr, ph = h - mt - mb, y0 = mt + ph;
  const max = Math.max(1, ...punkte.flatMap((p) => [p.val1, p.val2]));
  const n = punkte.length;
  const bw = Math.max(3, pw / (n * 3));
  const x = (i: number) => ml + (pw * (2 * i + 1)) / (2 * n);
  const hgt = (v: number) => (v > 0 ? (v / max) * ph : 0);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', maxWidth: 900 }} fontFamily="var(--sapFontFamily)" role="img" aria-label={titel}>
      {[0, 1, 2, 3, 4].map((k) => {
        const y = mt + (ph * k) / 4;
        return (
          <g key={k}>
            <line x1={ml} y1={y} x2={w - mr} y2={y} stroke={GRID} />
            <text x={ml - 8} y={y + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(max - (max * k) / 4)}</text>
          </g>
        );
      })}
      {punkte.map((p, i) => (
        <g key={p.label}>
          {p.val1 > 0 && <rect x={x(i) - bw - 1} y={y0 - hgt(p.val1)} width={bw} height={hgt(p.val1)} fill={C1} rx={2}><title>{`${name1} ${p.label}: ${p.val1.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`}</title></rect>}
          {p.val2 > 0 && <rect x={x(i) + 1} y={y0 - hgt(p.val2)} width={bw} height={hgt(p.val2)} fill={C2} rx={2}><title>{`${name2} ${p.label}: ${p.val2.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`}</title></rect>}
          <text x={x(i)} y={y0 + 16} textAnchor="middle" fontSize={10} fill={TEXT}>{p.label}</text>
        </g>
      ))}
      <line x1={ml} y1={y0} x2={w - mr} y2={y0} stroke={TEXT} />
      <line x1={ml} y1={mt} x2={ml} y2={y0} stroke={TEXT} />
      <text x={ml} y={20} fontSize={13} fontWeight="bold" fill={TITLE}>{titel}</text>
      <rect x={ml} y={28} width={14} height={9} fill={C1} rx={2} />
      <text x={ml + 20} y={36} fontSize={11} fill={TEXT}>{name1}</text>
      <rect x={ml + 140} y={28} width={14} height={9} fill={C2} rx={2} />
      <text x={ml + 160} y={36} fontSize={11} fill={TEXT}>{name2}</text>
    </svg>
  );
}
