/**
 * Gantt-Diagramm der Vorgänge eines Projekts: je Vorgang eine Zeile mit Balken (Meilenstein als Raute), erledigter Anteil,
 * Abhängigkeiten als Pfeile vom Ende des Vorgängers zum Beginn des Nachfolgers, kritischer Weg in der zweiten Diagrammfarbe,
 * Monatsraster und „heute“. Farben aus den Theme-Variablen des Portals; breite Pläne rollen im eigenen Rahmen.
 */
export interface GanttVorgang {
  id: number; nr: number; bezeichnung: string; beginn: string; ende: string; dauer: number; fertig: number; kritisch: boolean; puffer: number;
  vorgaenger: { id: number; nr: number; abstand: number }[];
}

const TAG = 86_400_000;
const nr = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / TAG);
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const tt = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function Gantt({ vorgaenge, beginn, ende }: { vorgaenge: GanttVorgang[]; beginn: string; ende: string }) {
  if (!vorgaenge.length) return null;
  const NAME = 230, KOPF = 34, ZEILE = 28, RAND = 16;
  // eine Woche Luft vor und nach dem Plan, damit Pfeile und Beschriftungen Platz haben
  const t0 = nr(beginn) - 3, t1 = nr(ende) + 8, tage = Math.max(1, t1 - t0);
  const px = Math.min(26, Math.max(2.5, 900 / tage));
  const W = NAME + tage * px + RAND, H = KOPF + vorgaenge.length * ZEILE + 8;
  const x = (tag: number) => NAME + (tag - t0) * px;
  const yMitte = (i: number) => KOPF + i * ZEILE + ZEILE / 2;
  const index = new Map(vorgaenge.map((v, i) => [v.id, i]));
  // Monatsanfänge im Fenster
  const monate: { tag: number; text: string }[] = [];
  const d = new Date((t0) * TAG);
  d.setUTCDate(1);
  for (; d.getTime() / TAG < t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const tag = Math.round(d.getTime() / TAG);
    if (tag >= t0) monate.push({ tag, text: `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` });
  }
  const wochen: number[] = [];
  if (px >= 6) for (let t = t0; t < t1; t++) if (new Date(t * TAG).getUTCDay() === 1) wochen.push(t);
  const heute = Math.floor(Date.now() / TAG);
  const kurz = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  return (
    <>
      <div className="pj-gantt">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Gantt-Diagramm, ${vorgaenge.length} Vorgänge von ${tt(beginn)} bis ${tt(ende)}`}>
          <rect className="kopf" x={0} y={0} width={W} height={KOPF} />
          {vorgaenge.map((_, i) => (i % 2 ? <rect key={i} className="streifen" x={0} y={KOPF + i * ZEILE} width={W} height={ZEILE} /> : null))}
          {wochen.map((t) => <line key={`w${t}`} className="raster" x1={x(t)} x2={x(t)} y1={KOPF} y2={H} strokeOpacity={0.45} />)}
          {monate.map((m) => (
            <g key={m.tag}>
              <line className="raster" x1={x(m.tag)} x2={x(m.tag)} y1={0} y2={H} />
              <text className="leise" x={x(m.tag) + 5} y={21}>{m.text}</text>
            </g>
          ))}
          <line className="raster" x1={NAME} x2={NAME} y1={0} y2={H} />
          <line className="raster" x1={0} x2={W} y1={KOPF} y2={KOPF} />
          <text className="leise" x={10} y={21}>Vorgang</text>
          {heute >= t0 && heute <= t1 && <line className="heute" x1={x(heute)} x2={x(heute)} y1={KOPF - 6} y2={H}><title>heute</title></line>}

          {/* Abhängigkeiten: vom Ende des Vorgängers nach unten bzw. oben zum Beginn des Nachfolgers */}
          {vorgaenge.flatMap((v, i) => v.vorgaenger.map((p) => {
            const j = index.get(p.id);
            if (j === undefined) return null;
            const vp = vorgaenge[j];
            const x1 = x(nr(vp.ende) + (vp.dauer ? 1 : 0)), y1 = yMitte(j), x2 = x(nr(v.beginn)), y2 = yMitte(i);
            const knick = Math.max(x1 + 5, Math.min(x2 - 6, x1 + 5));
            const weg = x2 - 6 >= knick
              ? `M${x1},${y1} H${knick} V${y2} H${x2 - 1}`
              : `M${x1},${y1} H${x1 + 5} V${y2 - ZEILE / 2 + (y2 > y1 ? 0 : ZEILE)} H${x2 - 8} V${y2} H${x2 - 1}`;
            return (
              <g key={`${v.id}-${p.id}`}>
                <path className="pfeil" d={weg} />
                <path className="spitze" d={`M${x2},${y2} l-6,-3.5 v7 z`} />
              </g>
            );
          }))}

          {vorgaenge.map((v, i) => {
            const xa = x(nr(v.beginn)), b = Math.max(3, v.dauer * px), y = yMitte(i);
            const tip = `${v.nr}. ${v.bezeichnung}: ${tt(v.beginn)}${v.dauer ? ` – ${tt(v.ende)} (${v.dauer} Tage)` : ' (Meilenstein)'}, ${v.fertig} % erledigt${v.kritisch ? ', kritischer Weg' : `, ${v.puffer} Tage Puffer`}`;
            return (
              <g key={v.id}>
                <text x={10} y={y + 4}><tspan className="leise">{v.nr}. </tspan>{kurz(v.bezeichnung, 30)}</text>
                {v.dauer ? (
                  <>
                    <rect className={`balken${v.kritisch ? ' kritisch' : ''}`} x={xa} y={y - 8} width={b} height={16} rx={3}><title>{tip}</title></rect>
                    {v.fertig > 0 && <rect className="anteil" x={xa} y={y - 8} width={(b * v.fertig) / 100} height={16} rx={3} />}
                  </>
                ) : <path className={`balken${v.kritisch ? ' kritisch' : ''}`} d={`M${xa},${y - 8} l8,8 l-8,8 l-8,-8 z`}><title>{tip}</title></path>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="pj-legende">
        <span><i />Vorgang</span><span><i className="kritisch" />kritischer Weg (ohne Puffer)</span><span>dunkel: erledigter Anteil</span><span>◆ Meilenstein</span><span>→ beginnt nach dem Vorgänger</span><span>gestrichelt: heute</span>
      </div>
    </>
  );
}
