import { MON } from './typen';

/**
 * Liniendiagramm über zwölf Monate mit EINER gemeinsamen Achse (kein Zweitachsen-Diagramm): Raster, Legende,
 * Wert als Tooltip am Punkt. Farben aus den Theme-Variablen des Portals (README „Oberflächen-Leitfaden“).
 */
export interface Serie { name: string; werte: (number | null)[]; farbe: 1 | 2 | 3 | 4; gestrichelt?: boolean }

const FARBE = (n: number) => `var(--sapChart_OrderedColor_${n}, ${['#0070F2', '#E76500', '#188918', '#7800A4'][n - 1]})`;
const GRID = 'var(--sapList_BorderColor, #D5DAE0)';
const TEXT = 'var(--sapContent_LabelColor, #556B82)';
const fmt = (v: number) => `${Math.round(v).toLocaleString('de-DE')} €`;
const kurz = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k` : Math.round(v).toLocaleString('de-DE'));

/** „Schöne“ Schrittweite für etwa vier Rasterlinien */
function achse(lo: number, hi: number): { lo: number; hi: number; schritt: number } {
  const roh = (hi - lo || 1) / 4, p = 10 ** Math.floor(Math.log10(roh));
  const schritt = [1, 2, 2.5, 5, 10].map((f) => f * p).find((s) => s >= roh) ?? roh;
  return { lo: Math.floor(lo / schritt) * schritt, hi: Math.ceil(hi / schritt) * schritt, schritt };
}

export function LinienDiagramm({ titel, serien, schmal = false }: { titel: string; serien: Serie[]; schmal?: boolean }) {
  const alle = serien.flatMap((s) => s.werte.filter((x): x is number => x !== null));
  if (!alle.length) return null;
  const W = schmal ? 420 : 800, H = schmal ? 250 : 300, L = schmal ? 44 : 62, R = schmal ? 12 : 20, T = 14, B = 28;
  const a = achse(Math.min(0, ...alle), Math.max(...alle, 1));
  const x = (i: number) => L + ((W - L - R) * i) / 11;
  const y = (v: number) => T + (H - T - B) * (1 - (v - a.lo) / (a.hi - a.lo || 1));
  const linien: number[] = [];
  for (let v = a.lo; v <= a.hi + a.schritt / 2; v += a.schritt) linien.push(v);
  return (
    <div className="hh-chart">
      <div className="hh-legende">
        {serien.map((s) => <span key={s.name}><i className={s.gestrichelt ? 'gestrichelt' : ''} style={{ borderTopColor: FARBE(s.farbe) }} />{s.name}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} fontFamily="var(--sapFontFamily)" role="img" aria-label={titel}>
        <title>{titel}</title>
        {linien.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={Math.abs(v) < 1e-9 ? TEXT : GRID} strokeWidth={1} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(v)}</text>
          </g>
        ))}
        {MON.map((m, i) => <text key={m} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill={TEXT}>{schmal ? m.slice(0, 1) : m}</text>)}
        {serien.map((s) => {
          const pts = s.werte.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
          return (
            <g key={s.name}>
              <polyline points={pts} fill="none" stroke={FARBE(s.farbe)} strokeWidth={2.5} strokeLinejoin="round" strokeDasharray={s.gestrichelt ? '6 4' : undefined} />
              {s.werte.map((v, i) => (v === null ? null : (
                <circle key={i} cx={x(i)} cy={y(v)} r={s.gestrichelt ? 2 : 3.5} fill={FARBE(s.farbe)} stroke="var(--sapGroup_ContentBackground, #fff)" strokeWidth={1.5}>
                  <title>{`${s.name} ${MON[i]}: ${fmt(v)}`}</title>
                </circle>
              )))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
