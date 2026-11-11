/**
 * SVG-Diagramme der Vereinsübersicht – Port von build_chart_svg, build_combo_svg,
 * build_stacked_bar_svg und build_fin_svg (Z2UI5_CL_TCO_REPORTING), responsive über viewBox.
 */
import { useMemo, type ReactNode } from 'react';
import { betrag } from '../util';
import { kurz, std, type Combo, type Point, type Stacked, type Verlauf } from './typen';

const C1 = 'var(--sapChart_OrderedColor_1, #0070f2)';
const C2 = 'var(--sapChart_OrderedColor_2, #e76500)';
const GOOD = 'var(--sapChart_Good, #188918)';
const BAD = 'var(--sapChart_Bad, #bb0000)';
const GRID = 'var(--sapList_BorderColor, #e5e5e5)';
const TXT = 'var(--sapContent_LabelColor, #6a6d70)';
const DARK = 'var(--sapTextColor, #32363a)';
const BG = 'var(--sapGroup_ContentBackground, #fff)';
const FONT = 'var(--sapFontFamily, "72", Arial, sans-serif)';

const Frame = ({ w, h, children, maxWidth = 820 }: { w: number; h: number; children: ReactNode; maxWidth?: number }) => (
  <svg viewBox={`0 0 ${w} ${h}`} className="portal-chart" style={{ maxWidth }} fontFamily={FONT} role="img">
    <rect x={0} y={0} width={w} height={h} fill={BG} stroke={GRID} rx={8} />
    {children}
  </svg>
);

/** Runde Skala (1-2-2,5-3-4-5-6-8 × 10^n) mit Platz über dem höchsten Punkt */
function nice(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 2.5, 3, 4, 5, 6, 8]) if (raw <= f * mag) return f * mag;
  return 10 * mag;
}

// ---------------------------------------------------------------- Linien (build_chart_svg)

interface LineProps { title: string; name1: string; name2?: string; data: Point[]; values?: boolean; placeholder?: boolean; anzahl?: boolean }

/** Ein oder zwei Linien je Beschriftung; `values` zeigt Werte (Stunden) an den Punkten und nutzt eine runde Skala */
/** `anzahl`: Werte sind Stückzahlen (z. B. Benutzer) – ganze Zahlen statt Euro */
export function LineChart({ title, name1, name2, data, values, placeholder, anzahl }: LineProps) {
  const W = 800, H = 280, ML = 74, MR = 24, MT = 48, MB = 44;
  const n = data.length;
  if (!n) return null;
  const pw = W - ML - MR, ph = H - MT - MB, y0 = MT + ph, two = !!name2;
  let min = 0, max = 0;
  for (const p of data) { min = Math.min(min, p.val1, two ? p.val2 : 0); max = Math.max(max, p.val1, two ? p.val2 : 0); }
  if (max <= min) max = min + 1;
  if (values) max = min + 4 * nice(((max - min) * 11) / 10 / 4);
  const x = (i: number) => (n > 1 ? ML + (pw * i) / (n - 1) : ML + pw / 2);
  const y = (v: number) => y0 - ((v - min) / (max - min)) * ph;
  const fmt = (v: number) => (values ? std(v) : anzahl && max - min <= 8 ? (Number.isInteger(v) ? String(v) : '') : kurz(v));
  const wert = (v: number) => (values ? std(v) : anzahl ? Math.round(v).toLocaleString('de-DE') : betrag(v));
  // bei vielen Punkten nur jede k-te Beschriftung (letzte immer)
  const step = Math.max(1, Math.ceil(n / 12));
  return (
    <Frame w={W} h={H}>
      {[0, 1, 2, 3, 4].map((k) => {
        const yy = y0 - (ph * k) / 4;
        return <g key={k}><line x1={ML} y1={yy} x2={W - MR} y2={yy} stroke={GRID} /><text x={ML - 8} y={yy + 4} textAnchor="end" fontSize={10} fill={TXT}>{fmt(min + ((max - min) * k) / 4)}</text></g>;
      })}
      {data.map((p, i) => ((i % step === 0 && (n - 1 - i >= step / 2 || i === n - 1)) || i === n - 1
        ? <text key={i} x={x(i)} y={y0 + 18} textAnchor={step > 1 && i === n - 1 ? 'end' : 'middle'} fontSize={10} fill={TXT}>{p.label}</text> : null))}
      <line x1={ML} y1={y0} x2={W - MR} y2={y0} stroke={TXT} />
      <line x1={ML} y1={MT} x2={ML} y2={y0} stroke={TXT} />
      {placeholder ? (
        <text x={ML + pw / 2} y={MT + ph / 2} textAnchor="middle" fontSize={13} fill={TXT}>Platzhalter - noch keine Datenquelle angebunden</text>
      ) : (
        <>
          <polyline points={data.map((p, i) => `${x(i)},${y(p.val1)}`).join(' ')} fill="none" stroke={C1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {two && <polyline points={data.map((p, i) => `${x(i)},${y(p.val2)}`).join(' ')} fill="none" stroke={C2} strokeWidth={2} strokeDasharray="6 3" strokeLinejoin="round" strokeLinecap="round" />}
          {data.map((p, i) => {
            const anchor = n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle';
            const tx = anchor === 'start' ? x(i) + 4 : anchor === 'end' ? x(i) - 4 : x(i);
            return (
              <g key={i}>
                <circle cx={x(i)} cy={y(p.val1)} r={3} fill={C1}><title>{`${name1} ${p.label}: ${wert(p.val1)}`}</title></circle>
                {values && <text x={tx} y={y(p.val1) - 9} textAnchor={anchor} fontSize={10} fontWeight="bold" fill={DARK}>{std(p.val1)}</text>}
                {two && <circle cx={x(i)} cy={y(p.val2)} r={3} fill={C2}><title>{`${name2} ${p.label}: ${wert(p.val2)}`}</title></circle>}
              </g>
            );
          })}
        </>
      )}
      <text x={ML} y={20} fontSize={13} fontWeight="bold" fill={DARK}>{title}</text>
      <line x1={ML} y1={32} x2={ML + 18} y2={32} stroke={C1} strokeWidth={3} />
      <text x={ML + 24} y={36} fontSize={11} fill={TXT}>{name1}</text>
      {two && <>
        <line x1={ML + 190} y1={32} x2={ML + 208} y2={32} stroke={C2} strokeWidth={3} strokeDasharray="6 3" />
        <text x={ML + 214} y={36} fontSize={11} fill={TXT}>{name2}</text>
      </>}
    </Frame>
  );
}

// ---------------------------------------------------------------- Kombi (build_combo_svg)

interface ComboProps { title: string; nameLine: string; namePos: string; nameNeg: string; data: Combo[] }

/** Linie (Bestand, rechte Achse) mit Balken nach oben (Eintritte) und unten (Austritte) um eine Nulllinie */
export function ComboChart({ title, nameLine, namePos, nameNeg, data }: ComboProps) {
  const W = 800, H = 300, ML = 58, MR = 58, MT = 52, MB = 40;
  const n = data.length;
  if (!n) return null;
  const pw = W - ML - MR, ph = H - MT - MB, y0 = MT + ph, zero = MT + ph / 2;
  let bmax = 0, lmin = data[0].val_line, lmax = data[0].val_line;
  for (const p of data) { bmax = Math.max(bmax, Math.abs(p.bar_pos), Math.abs(p.bar_neg)); lmin = Math.min(lmin, p.val_line); lmax = Math.max(lmax, p.val_line); }
  if (bmax === 0) bmax = 1;
  const span = lmax - lmin || 1;
  lmin -= span / 8; lmax += span / 8;
  const bw = Math.max(pw / (n * 3), 4);
  const x = (i: number) => ML + (pw * (2 * i + 1)) / (2 * n);
  const ly = (v: number) => y0 - ((v - lmin) / (lmax - lmin)) * ph;
  return (
    <Frame w={W} h={H}>
      {[0, 1, 2, 3, 4].map((k) => {
        const yy = MT + (ph * k) / 4;
        return (
          <g key={k}>
            <line x1={ML} y1={yy} x2={W - MR} y2={yy} stroke={GRID} />
            <text x={ML - 8} y={yy + 4} textAnchor="end" fontSize={10} fill={TXT}>{kurz(bmax - (2 * bmax * k) / 4)}</text>
            <text x={W - MR + 8} y={yy + 4} textAnchor="start" fontSize={10} fill={C1}>{kurz(lmax - ((lmax - lmin) * k) / 4)}</text>
          </g>
        );
      })}
      <line x1={ML} y1={y0} x2={W - MR} y2={y0} stroke={TXT} />
      <line x1={ML} y1={MT} x2={ML} y2={y0} stroke={TXT} />
      <line x1={ML} y1={zero} x2={W - MR} y2={zero} stroke={TXT} />
      {data.map((p, i) => {
        const hp = Math.max((Math.abs(p.bar_pos) / bmax) * ph / 2, 1), hn = Math.max((Math.abs(p.bar_neg) / bmax) * ph / 2, 1);
        return (
          <g key={i}>
            {p.bar_pos !== 0 && <>
              <rect x={x(i) - bw / 2} y={zero - hp} width={bw} height={hp} fill={GOOD} rx={2}><title>{`${namePos} ${p.label}: ${p.bar_pos}`}</title></rect>
              <text x={x(i)} y={zero - hp - 4} textAnchor="middle" fontSize={9} fill={GOOD}>{kurz(p.bar_pos)}</text>
            </>}
            {p.bar_neg !== 0 && <>
              <rect x={x(i) - bw / 2} y={zero} width={bw} height={hn} fill={BAD} rx={2}><title>{`${nameNeg} ${p.label}: ${Math.abs(p.bar_neg)}`}</title></rect>
              <text x={x(i)} y={zero + hn + 11} textAnchor="middle" fontSize={9} fill={BAD}>{kurz(p.bar_neg)}</text>
            </>}
            <text x={x(i)} y={y0 + 16} textAnchor="middle" fontSize={10} fill={TXT}>{p.label}</text>
          </g>
        );
      })}
      <polyline points={data.map((p, i) => `${x(i)},${ly(p.val_line)}`).join(' ')} fill="none" stroke={C1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((p, i) => <circle key={i} cx={x(i)} cy={ly(p.val_line)} r={3} fill={C1}><title>{`${nameLine} ${p.label}: ${p.val_line}`}</title></circle>)}
      <text x={ML} y={20} fontSize={13} fontWeight="bold" fill={DARK}>{title}</text>
      <line x1={ML} y1={32} x2={ML + 18} y2={32} stroke={C1} strokeWidth={3} />
      <text x={ML + 24} y={36} fontSize={11} fill={TXT}>{nameLine}</text>
      <rect x={ML + 200} y={28} width={14} height={9} fill={GOOD} rx={2} />
      <text x={ML + 220} y={36} fontSize={11} fill={TXT}>{namePos}</text>
      <rect x={ML + 320} y={28} width={14} height={9} fill={BAD} rx={2} />
      <text x={ML + 340} y={36} fontSize={11} fill={TXT}>{nameNeg}</text>
    </Frame>
  );
}

// ---------------------------------------------------------------- Gestapelte Balken (build_stacked_bar_svg)

/** Gruppierte, gestapelte Balken: Gruppe = x-Achse (Monat), Balken je Gruppe (Jahr), Segmente je Balken (Trainer / Buchungsart) */
export function StackedBarChart({ groups, bars, stacks, values, mainBar, title, unit, emptyText }: Stacked) {
  const pid = useMemo(() => `h${Math.random().toString(36).slice(2, 8)}`, []);
  const W = 960, ML = 56, MR = 20, PH = 260;
  const ng = groups.length, nb = bars.length;
  if (!ng || !nb) return null;
  // Summen je Balken und Skala
  const sum = new Map<string, number>();
  for (const v of values) sum.set(`${v.grp}|${v.bar}`, (sum.get(`${v.grp}|${v.bar}`) ?? 0) + v.value);
  const max = Math.max(0, ...sum.values());
  let step = Math.ceil(max / 4);
  if (step < 1) step = 1; else if (step > 10) step = Math.floor((step + 4) / 5) * 5;
  const top = step * 4;
  // Legende Segmente (mit Zeilenumbruch)
  const legend: ReactNode[] = [];
  let lx = ML, ly = 46;
  stacks.forEach((s, i) => {
    const iw = 20 + s.text.length * 6 + 18;
    if (lx + iw > W - MR && lx > ML) { lx = ML; ly += 18; }
    legend.push(<g key={`s${i}`}><rect x={lx} y={ly - 9} width={14} height={10} fill={s.hatch ? `url(#${pid}-${i})` : s.color} rx={2} /><text x={lx + 20} y={ly} fontSize={11} fill={TXT}>{s.text}</text></g>);
    lx += iw;
  });
  if (nb > 1) {
    lx = ML; ly += 20;
    bars.forEach((b, i) => {
      const main = b.key === mainBar;
      legend.push(<g key={`b${i}`}><rect x={lx} y={ly - 9} width={14} height={10} fill={DARK} fillOpacity={main ? 1 : 0.4} rx={2} /><text x={lx + 20} y={ly} fontSize={11} fill={DARK} fontWeight={main ? 'bold' : undefined}>{b.text}</text></g>);
      lx += 20 + b.text.length * 6 + 18;
    });
  }
  const MT = ly + 30, y0 = MT + PH, ylab = y0 + (nb > 1 ? 26 : 18), H = ylab + 16, pw = W - ML - MR;
  const fs = nb > 2 ? 8 : 9;
  const gw = pw / ng, bw = (gw * 8) / 10 / nb, bwi = Math.max(Math.trunc(bw) - 2, 3);
  const balken: ReactNode[] = [];
  groups.forEach((g, gi) => {
    bars.forEach((b, bi) => {
      const main = b.key === mainBar || nb === 1;
      const x = Math.trunc(ML + gw * gi + gw / 10 + bw * bi + 1), cx = x + bwi / 2;
      let cum = 0, yprev = y0;
      stacks.forEach((s, si) => {
        const v = values.find((z) => z.grp === gi + 1 && z.bar === b.key && z.stack === s.key);
        if (!v || v.value <= 0) return;
        cum += v.value;
        let y = y0 - (cum / top) * PH, hgt = yprev - y;
        if (hgt < 1) { hgt = 1; y = yprev - 1; }
        const t = std(v.value);
        balken.push(
          <g key={`${gi}-${bi}-${si}`}>
            <rect x={x} y={y} width={bwi} height={hgt} fill={s.hatch ? `url(#${pid}-${si})` : s.color} fillOpacity={main ? 1 : 0.4} stroke="#fff" strokeWidth={0.5}>
              <title>{`${g} ${b.key} · ${s.key === 'GESAMT' ? 'gesamt' : s.text.replace(/\s*\(.*$/, '')}: ${t} ${unit}`}</title>
            </rect>
            {hgt >= 12 && bwi >= t.length * 5 + 2 && <text x={cx} y={y + hgt / 2 + 3} textAnchor="middle" fontSize={fs} fill={main && !s.hatch ? '#fff' : DARK}>{t}</text>}
          </g>,
        );
        yprev = y;
      });
      if (cum > 0) balken.push(<text key={`t${gi}-${bi}`} x={cx} y={yprev - 4} textAnchor="middle" fontSize={fs} fontWeight="bold" fill={main ? DARK : TXT}>{std(cum)}</text>);
      if (nb > 1) balken.push(<text key={`k${gi}-${bi}`} x={cx} y={y0 + 12} textAnchor="middle" fontSize={8} fill={TXT}>{b.kurz}</text>);
    });
    balken.push(<text key={`g${gi}`} x={ML + gw * gi + gw / 2} y={ylab} textAnchor="middle" fontSize={10} fill={TXT}>{g}</text>);
  });
  return (
    <Frame w={W} h={H} maxWidth={1100}>
      <defs>
        {stacks.map((s, i) => s.hatch && (
          <pattern key={i} id={`${pid}-${i}`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
            <rect x={0} y={0} width={6} height={6} fill={s.color} fillOpacity={0.2} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={s.color} strokeWidth={2.5} strokeOpacity={0.7} />
          </pattern>
        ))}
      </defs>
      <text x={ML} y={22} fontSize={13} fontWeight="bold" fill={DARK}>{title}</text>
      {legend}
      {[0, 1, 2, 3, 4].map((k) => {
        const yy = y0 - (PH * k) / 4;
        return <g key={k}><line x1={ML} y1={yy} x2={W - MR} y2={yy} stroke={GRID} /><text x={ML - 8} y={yy + 4} textAnchor="end" fontSize={10} fill={TXT}>{std(step * k)}</text></g>;
      })}
      {unit && <text x={ML - 8} y={MT - 12} textAnchor="end" fontSize={10} fill={TXT}>{unit}</text>}
      {balken}
      <line x1={ML} y1={y0} x2={W - MR} y2={y0} stroke={TXT} />
      <line x1={ML} y1={MT} x2={ML} y2={y0} stroke={TXT} />
      {max === 0 && emptyText && <text x={ML + pw / 2} y={MT + PH / 2} textAnchor="middle" fontSize={13} fill={TXT}>{emptyText}</text>}
    </Frame>
  );
}

// ---------------------------------------------------------------- Finanzen (build_fin_svg)

/** Säulen Einnahmen/Ausgaben je Monat (linke Achse) + Linie Kontostand Monatsende (rechte Achse) */
export function FinChart({ title, data, mehrjahr }: { title: string; data: Verlauf[]; mehrjahr: boolean }) {
  const W = 1000, H = 320, ML = 64, MR = 72, MT = 56, MB = 44;
  const n = data.length;
  if (!n) return null;
  const pw = W - ML - MR, ph = H - MT - MB, y0 = MT + ph;
  let bmax = 0, lmin = 0, lmax = 0, first = true;
  for (const p of data) {
    bmax = Math.max(bmax, p.einnahmen, p.ausgaben);
    if (!p.zukunft) { if (first) { lmin = lmax = p.bestand; first = false; } else { lmin = Math.min(lmin, p.bestand); lmax = Math.max(lmax, p.bestand); } }
  }
  if (bmax <= 0) bmax = 1;
  lmin = Math.min(lmin, 0);                        // Kontostand-Achse ab 0, damit die Linie nicht überzeichnet wirkt
  if (lmax <= lmin) lmax = lmin + 1;
  const slot = pw / n, bw = Math.max(Math.trunc(slot * 0.32), 2);
  const x = (i: number) => Math.trunc(ML + slot * i + slot / 2);
  const ly = (v: number) => MT + ((lmax - v) / (lmax - lmin)) * ph;
  const mm = (p: Verlauf) => String(p.monat).padStart(2, '0');
  const ist = data.filter((p) => !p.zukunft);
  return (
    <Frame w={W} h={H} maxWidth={1200}>
      {[0, 1, 2, 3, 4].map((k) => {
        const yy = MT + (ph * k) / 4;
        return (
          <g key={k}>
            <line x1={ML} y1={yy} x2={W - MR} y2={yy} stroke={GRID} />
            <text x={ML - 8} y={yy + 4} textAnchor="end" fontSize={10} fill={TXT}>{kurz(bmax - (bmax * k) / 4)}</text>
            <text x={W - MR + 8} y={yy + 4} textAnchor="start" fontSize={10} fill={C1}>{kurz(lmax - ((lmax - lmin) * k) / 4)}</text>
          </g>
        );
      })}
      {data.map((p, i) => (
        <g key={i}>
          {mehrjahr && p.monat === 1 && i > 0 && <>
            <line x1={Math.trunc(ML + slot * i)} y1={MT} x2={Math.trunc(ML + slot * i)} y2={y0} stroke={TXT} strokeDasharray="3,3" />
            <text x={Math.trunc(ML + slot * i) + 4} y={MT + 10} fontSize={10} fill={TXT}>{p.jahr}</text>
          </>}
          {p.einnahmen > 0 && <rect x={x(i) - bw - 1} y={y0 - (p.einnahmen / bmax) * ph} width={bw} height={(p.einnahmen / bmax) * ph} fill={GOOD} rx={2}><title>{`Einnahmen ${mm(p)}/${p.jahr}: ${betrag(p.einnahmen)} EUR`}</title></rect>}
          {p.ausgaben > 0 && <rect x={x(i) + 1} y={y0 - (p.ausgaben / bmax) * ph} width={bw} height={(p.ausgaben / bmax) * ph} fill={C2} rx={2}><title>{`Ausgaben ${mm(p)}/${p.jahr}: ${betrag(p.ausgaben)} EUR`}</title></rect>}
          {(n <= 24 || i % 3 === 0) && <text x={x(i)} y={y0 + 16} textAnchor="middle" fontSize={10} fill={TXT}>{mehrjahr ? `${mm(p)}/${String(p.jahr).slice(2)}` : mm(p)}</text>}
        </g>
      ))}
      <line x1={ML} y1={y0} x2={W - MR} y2={y0} stroke={TXT} />
      {ist.length > 0 && <>
        <polyline points={data.map((p, i) => (p.zukunft ? null : `${x(i)},${ly(p.bestand)}`)).filter(Boolean).join(' ')} fill="none" stroke={C1} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((p, i) => !p.zukunft && <circle key={i} cx={x(i)} cy={ly(p.bestand)} r={3} fill="#fff" stroke={C1} strokeWidth={2}><title>{`Kontostand Ende ${mm(p)}/${p.jahr}: ${betrag(p.bestand)} EUR`}</title></circle>)}
      </>}
      <text x={ML} y={20} fontSize={13} fontWeight="bold" fill={DARK}>{title}</text>
      <rect x={ML} y={30} width={14} height={9} fill={GOOD} rx={2} />
      <text x={ML + 20} y={38} fontSize={11} fill={TXT}>Einnahmen (linke Achse)</text>
      <rect x={ML + 180} y={30} width={14} height={9} fill={C2} rx={2} />
      <text x={ML + 200} y={38} fontSize={11} fill={TXT}>Ausgaben (linke Achse)</text>
      <line x1={ML + 360} y1={35} x2={ML + 380} y2={35} stroke={C1} strokeWidth={2.5} />
      <circle cx={ML + 370} cy={35} r={3} fill="#fff" stroke={C1} strokeWidth={2} />
      <text x={ML + 386} y={38} fontSize={11} fill={TXT}>Kontostand Monatsende (rechte Achse)</text>
    </Frame>
  );
}
