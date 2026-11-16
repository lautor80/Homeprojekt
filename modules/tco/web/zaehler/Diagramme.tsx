import { useId } from 'react';
import { useKlein } from '@core/components/ResponsiveTable';
import { MONATE, zahl } from './format';
import './zaehler.css';

/**
 * SVG-Diagramme der App „Zählerstände“ ohne Zusatzbibliothek (Vorbild: haushalt/Diagramm.tsx, finanz/Diagramme.tsx):
 * Farben ausschließlich aus den Theme-Variablen `--sapChart_OrderedColor_1…11` (hell/dunkel), eine gemeinsame Achse,
 * Raster, Achsenbeschriftung, Legende (ab zwei Reihen) und Werte als Tooltip (<title>). Größe über viewBox → responsiv.
 */
const ERSATZ = ['#0070F2', '#E76500', '#188918', '#7800A4', '#E04F81', '#00A3A3', '#A93E00', '#5D36FF', '#4C6F00', '#C0399F', '#0057D2'];
/** Farbe n (1…11) der geordneten Diagrammfarben; Reihe 12 ff. beginnt wieder vorn (kommt bei Zählern praktisch nicht vor) */
export const FARBE = (n: number) => { const i = ((n - 1) % 11) + 1; return `var(--sapChart_OrderedColor_${i}, ${ERSATZ[i - 1]})`; };
const GRID = 'var(--sapList_BorderColor, #D5DAE0)';
const TEXT = 'var(--sapContent_LabelColor, #556B82)';
const FLAECHE = 'var(--sapGroup_ContentBackground, #fff)';

/** „Schöne“ Schrittweite für etwa vier Rasterlinien */
export function achse(lo: number, hi: number): { lo: number; hi: number; schritt: number; linien: number[] } {
  const roh = (hi - lo || 1) / 4, p = 10 ** Math.floor(Math.log10(roh));
  const schritt = [1, 2, 2.5, 5, 10].map((f) => f * p).find((s) => s >= roh) ?? roh;
  const a = Math.floor(lo / schritt) * schritt, b = Math.ceil(hi / schritt) * schritt || schritt;
  const linien: number[] = [];
  for (let v = a; v <= b + schritt / 2; v += schritt) linien.push(Math.round(v / schritt) * schritt);
  return { lo: a, hi: b, schritt, linien };
}
/** Achsenbeschriftung: ab 1000 in „k“ */
const kurz = (v: number) => (Math.abs(v) >= 10_000 ? `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k` : zahl(v, Math.abs(v) >= 10 ? 0 : 1));

export interface Reihe {
  name: string;
  werte: (number | null)[];
  /** Farbnummer 1…11 – bleibt beim Filtern an der Reihe (Farbe folgt dem Zähler, nicht dem Rang) */
  farbe: number;
  /** je Wert: geschätzt (Säule schraffiert/heller) */
  geschaetzt?: boolean[];
  gestrichelt?: boolean;
}

function Legende({ reihen, mitSchaetzung }: { reihen: Reihe[]; mitSchaetzung?: boolean }) {
  if (reihen.length < 2 && !mitSchaetzung) return null;
  return (
    <div className="zs-legende">
      {reihen.length >= 2 && reihen.map((r) => <span key={r.name}><i className={r.gestrichelt ? 'gestrichelt' : ''} style={{ borderTopColor: FARBE(r.farbe) }} />{r.name}</span>)}
      {mitSchaetzung && <span><i className="schraffiert" />geschätzt bzw. aus Schätzung abgeleitet</span>}
    </div>
  );
}

/** eindeutige, in url(#…) gültige Kennung */
const useSvgId = () => `zs${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

/**
 * Gruppierte Säulen: je Kategorie (Monat/Jahr) eine Säule je Reihe (Zähler). Geschätzte Werte werden schraffiert und
 * heller gezeichnet. `fmt` formatiert den Wert für den Tooltip (Einheit bzw. €).
 */
export function SaeulenDiagramm({ titel, kategorien, reihen, fmt, kategorieText = (k) => k }: {
  titel: string; kategorien: string[]; reihen: Reihe[]; fmt: (v: number) => string; kategorieText?: (k: string, schmal: boolean) => string;
}) {
  const schmal = useKlein();
  const id = useSvgId();
  const alle = reihen.flatMap((r) => r.werte.filter((x): x is number => x !== null));
  if (!kategorien.length || !reihen.length) return null;
  const W = schmal ? 420 : 800, H = schmal ? 250 : 300, L = schmal ? 40 : 56, R = 10, T = 12, B = 30;
  const a = achse(Math.min(0, ...alle), Math.max(1e-9, ...alle));
  const pw = W - L - R, slot = pw / kategorien.length;
  const gruppe = slot * 0.78, bw = Math.max(1.5, gruppe / reihen.length - (reihen.length > 1 ? 2 : 0));
  const y = (v: number) => T + (H - T - B) * (1 - (v - a.lo) / (a.hi - a.lo || 1));
  const y0 = y(0);
  const jede = Math.max(1, Math.ceil(kategorien.length / (schmal ? 6 : 14)));
  const mitSchaetzung = reihen.some((r) => r.geschaetzt?.some(Boolean));
  return (
    <div className="zs-chart">
      <Legende reihen={reihen} mitSchaetzung={mitSchaetzung} />
      <svg viewBox={`0 0 ${W} ${H}`} fontFamily="var(--sapFontFamily)" role="img" aria-label={titel}>
        <title>{titel}</title>
        <defs>
          {reihen.map((r, j) => (
            <pattern key={j} id={`${id}s${j}`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill={FARBE(r.farbe)} opacity={0.3} />
              <line x1={0} y1={0} x2={0} y2={6} stroke={FARBE(r.farbe)} strokeWidth={2.5} />
            </pattern>
          ))}
        </defs>
        {a.linien.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={Math.abs(v) < 1e-9 ? TEXT : GRID} strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(v)}</text>
          </g>
        ))}
        {kategorien.map((k, i) => {
          const x0 = L + slot * i + (slot - gruppe) / 2;
          return (
            <g key={k}>
              {reihen.map((r, j) => {
                const v = r.werte[i];
                if (v === null || v === undefined) return null;
                const geschaetzt = !!r.geschaetzt?.[i];
                const top = Math.min(y(v), y0), h = Math.max(Math.abs(y0 - y(v)), v === 0 ? 0 : 1);
                return (
                  <rect key={j} x={x0 + j * (gruppe / reihen.length) + (reihen.length > 1 ? 1 : 0)} y={top} width={bw} height={h} rx={Math.min(3, bw / 2)}
                        fill={geschaetzt ? `url(#${id}s${j})` : FARBE(r.farbe)} stroke={geschaetzt ? FARBE(r.farbe) : undefined} strokeWidth={geschaetzt ? 1 : 0}>
                    <title>{`${reihen.length > 1 ? `${r.name} – ` : ''}${kategorieText(k, false)}: ${fmt(v)}${geschaetzt ? ' (geschätzt)' : ''}`}</title>
                  </rect>
                );
              })}
              {i % jede === 0 && <text x={L + slot * i + slot / 2} y={H - 10} textAnchor="middle" fontSize={10} fill={TEXT}>{kategorieText(k, schmal)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Linien je Reihe über feste Kategorien (z. B. Jahresvergleich Jan–Dez: eine Linie je Jahr) */
export function KategorieLinien({ titel, kategorien = MONATE, reihen, fmt }: { titel: string; kategorien?: string[]; reihen: Reihe[]; fmt: (v: number) => string }) {
  const schmal = useKlein();
  const alle = reihen.flatMap((r) => r.werte.filter((x): x is number => x !== null));
  if (!alle.length) return null;
  const W = schmal ? 420 : 800, H = schmal ? 250 : 300, L = schmal ? 40 : 56, R = 14, T = 12, B = 28;
  const a = achse(Math.min(0, ...alle), Math.max(1e-9, ...alle));
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / kategorien.length;
  const y = (v: number) => T + (H - T - B) * (1 - (v - a.lo) / (a.hi - a.lo || 1));
  return (
    <div className="zs-chart">
      <Legende reihen={reihen} />
      <svg viewBox={`0 0 ${W} ${H}`} fontFamily="var(--sapFontFamily)" role="img" aria-label={titel}>
        <title>{titel}</title>
        {a.linien.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={Math.abs(v) < 1e-9 ? TEXT : GRID} strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(v)}</text>
          </g>
        ))}
        {kategorien.map((k, i) => <text key={k} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill={TEXT}>{schmal ? k.slice(0, 1) : k}</text>)}
        {reihen.map((r) => {
          // Lücken (null) unterbrechen die Linie
          const stuecke: string[][] = [[]];
          r.werte.forEach((v, i) => { if (v === null) stuecke.push([]); else stuecke[stuecke.length - 1].push(`${x(i)},${y(v)}`); });
          return (
            <g key={r.name}>
              {stuecke.filter((s) => s.length > 1).map((s, j) => (
                <polyline key={j} points={s.join(' ')} fill="none" stroke={FARBE(r.farbe)} strokeWidth={2} strokeLinejoin="round" strokeDasharray={r.gestrichelt ? '6 4' : undefined} />
              ))}
              {r.werte.map((v, i) => (v === null ? null : (
                <circle key={i} cx={x(i)} cy={y(v)} r={4} fill={FARBE(r.farbe)} stroke={FLAECHE} strokeWidth={2}>
                  <title>{`${r.name} ${kategorien[i]}: ${fmt(v)}`}</title>
                </circle>
              )))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export interface StandPunkt { datum: string; stand: number; art: string; text: string }

/**
 * Zählerstand über die Zeit (zeitlich skaliert). Ein Zählerwechsel (EINBAU) unterbricht die Linie und ist als
 * gestrichelte senkrechte Linie mit Beschriftung markiert; Schätzungen als hohle Punkte.
 */
export function StandVerlauf({ titel, punkte, fmt }: { titel: string; punkte: StandPunkt[]; fmt: (v: number) => string }) {
  const schmal = useKlein();
  if (punkte.length < 1) return null;
  const p = [...punkte].sort((u, v) => u.datum.localeCompare(v.datum));
  const t = (d: string) => new Date(`${d}T12:00:00`).getTime();
  const t0 = t(p[0].datum), t1 = Math.max(t(p[p.length - 1].datum), t0 + 86_400_000);
  const W = schmal ? 420 : 800, H = schmal ? 250 : 300, L = schmal ? 48 : 64, R = 14, T = 18, B = 28;
  const a = achse(Math.min(...p.map((x) => x.stand)), Math.max(...p.map((x) => x.stand)));
  const x = (d: string) => L + ((W - L - R) * (t(d) - t0)) / (t1 - t0);
  const y = (v: number) => T + (H - T - B) * (1 - (v - a.lo) / (a.hi - a.lo || 1));
  const stuecke: StandPunkt[][] = [[]];
  for (const q of p) { if (q.art === 'EINBAU' && stuecke[stuecke.length - 1].length) stuecke.push([]); stuecke[stuecke.length - 1].push(q); }
  const wechsel = p.filter((q, i) => q.art === 'EINBAU' && i > 0);
  // Jahresmarken an der x-Achse
  const jahre: number[] = [];
  for (let j = new Date(t0).getFullYear() + 1; j <= new Date(t1).getFullYear(); j++) jahre.push(j);
  const ersteJahr = new Date(t0).getFullYear();
  return (
    <div className="zs-chart">
      <svg viewBox={`0 0 ${W} ${H}`} fontFamily="var(--sapFontFamily)" role="img" aria-label={titel}>
        <title>{titel}</title>
        {a.linien.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill={TEXT}>{kurz(v)}</text>
          </g>
        ))}
        <text x={L} y={H - 8} fontSize={10} fill={TEXT}>{ersteJahr === new Date(t1).getFullYear() || !jahre.length ? `${p[0].datum.slice(8, 10)}.${p[0].datum.slice(5, 7)}.${ersteJahr}` : ersteJahr}</text>
        {jahre.map((j) => {
          const xx = x(`${j}-01-01`);
          return <g key={j}><line x1={xx} x2={xx} y1={T} y2={H - B} stroke={GRID} strokeDasharray="2 3" /><text x={xx} y={H - 8} textAnchor="middle" fontSize={10} fill={TEXT}>{j}</text></g>;
        })}
        {wechsel.map((w) => (
          <g key={w.datum}>
            <line x1={x(w.datum)} x2={x(w.datum)} y1={T - 6} y2={H - B} stroke={TEXT} strokeDasharray="5 3" />
            <text x={x(w.datum) + 4} y={T - 6} fontSize={10} fill={TEXT}>Zählerwechsel</text>
          </g>
        ))}
        {stuecke.filter((s) => s.length > 1).map((s, j) => (
          <polyline key={j} points={s.map((q) => `${x(q.datum)},${y(q.stand)}`).join(' ')} fill="none" stroke={FARBE(1)} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {p.map((q, i) => (
          <circle key={i} cx={x(q.datum)} cy={y(q.stand)} r={p.length > 60 ? 2.5 : 4} fill={q.art === 'SCHAETZUNG' ? FLAECHE : FARBE(1)} stroke={q.art === 'SCHAETZUNG' ? FARBE(1) : FLAECHE} strokeWidth={2}>
            <title>{`${q.text}: ${fmt(q.stand)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/** Kleiner Verlauf ohne Achsen (Übersicht: Monatsverbrauch der letzten 12 Monate) */
export function Sparkline({ werte, titel, fmt }: { werte: number[]; titel: string; fmt: (v: number) => string }) {
  if (werte.length < 2) return null;
  const W = 120, H = 32, P = 3;
  const max = Math.max(...werte, 1e-9), min = Math.min(0, ...werte);
  const x = (i: number) => P + ((W - 2 * P) * i) / (werte.length - 1);
  const y = (v: number) => H - P - ((H - 2 * P) * (v - min)) / (max - min || 1);
  const pts = werte.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const letzt = werte.length - 1;
  return (
    <svg className="zs-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={titel}>
      <title>{`${titel}: ${werte.map(fmt).join(' · ')}`}</title>
      <polygon points={`${x(0)},${H - P} ${pts} ${x(letzt)},${H - P}`} fill={FARBE(1)} opacity={0.15} />
      <polyline points={pts} fill="none" stroke={FARBE(1)} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(letzt)} cy={y(werte[letzt])} r={2.5} fill={FARBE(1)} />
    </svg>
  );
}
