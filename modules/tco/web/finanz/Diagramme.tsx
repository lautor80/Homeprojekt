/** SVG-Diagramme für Einnahmen & Ausgaben – nach BUILD_BARS_SVG der SAP-App, ohne Zusatzbibliothek */

const C1 = 'var(--sapChart_OrderedColor_1, #0070F2)';
const C2 = 'var(--sapChart_OrderedColor_2, #E76500)';
const C3 = 'var(--sapChart_OrderedColor_3, #188918)';
const GRID = 'var(--sapList_BorderColor, #D5DAE0)';
const TEXT = 'var(--sapContent_LabelColor, #556B82)';
const TITLE = 'var(--sapTextColor, #32363A)';

const fmt = (v: number, d = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Achsenbeschriftung wie CONV_SHORT: ab 1000 in „k“ mit einer Nachkommastelle */
const kurz = (v: number) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000, 1)}k` : fmt(v));

export interface BalkenPunkt { label: string; val1: number; val2: number }

/** Zwei Säulen je Punkt (z. B. Einnahmen und Ausgaben je Monat) mit Raster, Achsen und Legende */
export function BalkenDiagramm({ titel, name1, name2, punkte }: { titel: string; name1: string; name2: string; punkte: BalkenPunkt[] }) {
  if (!punkte.length) return null;
  const W = 800, H = 300, ML = 66, MR = 20, MT = 52, MB = 40;
  const pw = W - ML - MR, ph = H - MT - MB, y0 = MT + ph;
  const max = Math.max(1, ...punkte.flatMap((p) => [p.val1, p.val2]));
  const bw = Math.max(3, pw / (punkte.length * 3));
  const x = (i: number) => ML + (pw * (2 * i + 1)) / (2 * punkte.length);
  const h = (v: number) => (v > 0 ? (v / max) * ph : 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 820 }} fontFamily="var(--sapFontFamily)" role="img" aria-label={titel}>
      {[0, 1, 2, 3, 4].map((k) => {
        const y = MT + (ph * k) / 4;
        return <g key={k}><line x1={ML} y1={y} x2={W - MR} y2={y} stroke={GRID} /><text x={ML - 8} y={y + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(max - (max * k) / 4)}</text></g>;
      })}
      {punkte.map((p, i) => (
        <g key={i}>
          {p.val1 > 0 && <rect x={x(i) - bw - 1} y={y0 - h(p.val1)} width={bw} height={h(p.val1)} fill={C1} rx={2}><title>{`${name1} ${p.label}: ${fmt(p.val1, 2)} €`}</title></rect>}
          {p.val2 > 0 && <rect x={x(i) + 1} y={y0 - h(p.val2)} width={bw} height={h(p.val2)} fill={C2} rx={2}><title>{`${name2} ${p.label}: ${fmt(p.val2, 2)} €`}</title></rect>}
          <text x={x(i)} y={y0 + 16} textAnchor="middle" fontSize={10} fill={TEXT}>{p.label}</text>
        </g>
      ))}
      <line x1={ML} y1={y0} x2={W - MR} y2={y0} stroke={TEXT} />
      <line x1={ML} y1={MT} x2={ML} y2={y0} stroke={TEXT} />
      <text x={ML} y={20} fontSize={13} fontWeight="bold" fill={TITLE}>{titel}</text>
      <rect x={ML} y={28} width={14} height={9} fill={C1} rx={2} />
      <text x={ML + 20} y={36} fontSize={11} fill={TEXT}>{name1}</text>
      <rect x={ML + 140} y={28} width={14} height={9} fill={C2} rx={2} />
      <text x={ML + 160} y={36} fontSize={11} fill={TEXT}>{name2}</text>
    </svg>
  );
}

export interface VerlaufPunkt { label: string; einnahmen: number; ausgaben: number; bestand: number; zukunft: boolean }

/**
 * Monatsverlauf über mehrere Jahre: Säulen Einnahmen/Ausgaben (linke Achse) und Linie Kontostand
 * der gewählten Geldkonten zum Monatsende (rechte Achse). Zukünftige Monate werden blass gezeichnet.
 */
export function VerlaufDiagramm({ punkte }: { punkte: VerlaufPunkt[] }) {
  if (!punkte.length) return null;
  const W = 800, H = 320, ML = 66, MR = 70, MT = 52, MB = 44;
  const pw = W - ML - MR, ph = H - MT - MB, y0 = MT + ph;
  const maxB = Math.max(1, ...punkte.flatMap((p) => [p.einnahmen, p.ausgaben]));
  const bMin = Math.min(0, ...punkte.map((p) => p.bestand)), bMax = Math.max(1, ...punkte.map((p) => p.bestand));
  const bRange = bMax - bMin || 1;
  const slot = pw / punkte.length, bw = Math.max(2, slot * 0.3);
  const x = (i: number) => ML + slot * i + slot / 2;
  const hb = (v: number) => (v > 0 ? (v / maxB) * ph : 0);
  const yl = (v: number) => y0 - ((v - bMin) / bRange) * ph;
  // Jahresgrenzen beschriften (Label „MM/JJJJ“ → Jahr)
  const jahre = punkte.map((p, i) => ({ i, jahr: p.label.slice(-4) })).filter((p, i, a) => i === 0 || a[i - 1].jahr !== p.jahr);
  const dicht = punkte.length > 24;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 820 }} fontFamily="var(--sapFontFamily)" role="img" aria-label="Monatsverlauf">
      {[0, 1, 2, 3, 4].map((k) => {
        const y = MT + (ph * k) / 4;
        return (
          <g key={k}>
            <line x1={ML} y1={y} x2={W - MR} y2={y} stroke={GRID} />
            <text x={ML - 8} y={y + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(maxB - (maxB * k) / 4)}</text>
            <text x={W - MR + 8} y={y + 4} textAnchor="start" fontSize={10} fill={C3}>{kurz(bMax - (bRange * k) / 4)}</text>
          </g>
        );
      })}
      {punkte.map((p, i) => (
        <g key={i} opacity={p.zukunft ? 0.35 : 1}>
          {p.einnahmen > 0 && <rect x={x(i) - bw - 0.5} y={y0 - hb(p.einnahmen)} width={bw} height={hb(p.einnahmen)} fill={C1} rx={1}><title>{`Einnahmen ${p.label}: ${fmt(p.einnahmen, 2)} €`}</title></rect>}
          {p.ausgaben > 0 && <rect x={x(i) + 0.5} y={y0 - hb(p.ausgaben)} width={bw} height={hb(p.ausgaben)} fill={C2} rx={1}><title>{`Ausgaben ${p.label}: ${fmt(p.ausgaben, 2)} €`}</title></rect>}
          {(!dicht || i % 3 === 0) && <text x={x(i)} y={y0 + 14} textAnchor="middle" fontSize={9} fill={TEXT}>{p.label.slice(0, 2)}</text>}
        </g>
      ))}
      {jahre.map((j) => (
        <g key={j.i}>
          {j.i > 0 && <line x1={ML + slot * j.i} y1={MT} x2={ML + slot * j.i} y2={y0} stroke={GRID} strokeDasharray="3 3" />}
          <text x={ML + slot * j.i + 4} y={y0 + 30} fontSize={11} fontWeight="bold" fill={TEXT}>{j.jahr}</text>
        </g>
      ))}
      <polyline points={punkte.map((p, i) => `${x(i)},${yl(p.bestand)}`).join(' ')} fill="none" stroke={C3} strokeWidth={2.5} strokeLinejoin="round" />
      {punkte.map((p, i) => (
        <circle key={i} cx={x(i)} cy={yl(p.bestand)} r={dicht ? 2 : 3.5} fill="#fff" stroke={C3} strokeWidth={2} opacity={p.zukunft ? 0.35 : 1}>
          <title>{`Kontostand ${p.label}: ${fmt(p.bestand, 2)} €`}</title>
        </circle>
      ))}
      <line x1={ML} y1={y0} x2={W - MR} y2={y0} stroke={TEXT} />
      <line x1={ML} y1={MT} x2={ML} y2={y0} stroke={TEXT} />
      <text x={ML} y={20} fontSize={13} fontWeight="bold" fill={TITLE}>Monatsverlauf Geldkonten</text>
      <rect x={ML} y={28} width={14} height={9} fill={C1} rx={2} />
      <text x={ML + 20} y={36} fontSize={11} fill={TEXT}>Einnahmen</text>
      <rect x={ML + 110} y={28} width={14} height={9} fill={C2} rx={2} />
      <text x={ML + 130} y={36} fontSize={11} fill={TEXT}>Ausgaben</text>
      <line x1={ML + 220} y1={32} x2={ML + 244} y2={32} stroke={C3} strokeWidth={2.5} />
      <text x={ML + 250} y={36} fontSize={11} fill={TEXT}>Kontostand Monatsende (rechte Achse)</text>
    </svg>
  );
}
