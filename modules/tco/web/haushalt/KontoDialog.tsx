import { useState } from 'react';
import { Button, Dialog, Input, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import { FussLeiste } from '@core/components/DialogFuss';
import { api } from '@core/api';
import { toast } from '@core/toast';
import { euro, HH, MONATE, prozent, RECHEN_METHODEN, zahlLesen, zahlText, type Init, type PlanSicht, type Position } from './typen';

/**
 * Einzelheiten eines Kontos im Haushaltsplan: Grundlage je Jahr mit Sondereffekten, Werte und Treffsicherheit je
 * Methode, Monatsverlauf, Zuschlag, Notiz, Vorgängerkonto. Sondereffekt und Vorgänger gelten für alle Pläne.
 */
export function KontoDialog({ s, p, init, edit, onClose }: { s: PlanSicht; p: Position; init: Init; edit: boolean; onClose: (geaendert: boolean) => void }) {
  const g = p.grundlage;
  const aenderbar = edit && s.aenderbar;
  const [error, setError] = useState<string | null>(null);
  const [geaendert, setGeaendert] = useState(false);
  const [gruende, setGruende] = useState<Record<number, string>>(() => Object.fromEntries((g?.sonder ?? []).map((x) => [x.jahr, x.grund])));
  const [monate, setMonate] = useState<string[]>(() => p.monate.map((m) => zahlText(m)));
  const [zuschlag, setZuschlag] = useState(zahlText(p.zuschlag));
  const [notiz, setNotiz] = useState(p.notiz ?? '');
  const [vorg, setVorg] = useState(g?.vorgaenger?.konto ?? '');
  const [abJahr, setAbJahr] = useState(String(g?.vorgaenger?.ab_jahr ?? s.basisjahr));

  async function tun(f: () => Promise<{ text?: string } | unknown>, schliessen = true) {
    setError(null);
    try {
      const r = await f() as { text?: string };
      if (r?.text) toast(r.text);
      setGeaendert(true);
      if (schliessen) onClose(true);
    } catch (e) { setError((e as Error).message); }
  }
  const summe = monate.reduce((a, m) => a + (zahlLesen(m) ?? 0), 0);
  const passt = Math.abs(summe - p.planwert) < 0.005;

  return (
    <Dialog open headerText={`${p.konto} ${p.name}`} onClose={() => onClose(geaendert)}
            footer={<FussLeiste endContent={<Button onClick={() => onClose(geaendert)}>Schließen</Button>} />}>
      <div className="hh-dialog">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}
        <Text>{p.art === 'E' ? 'Einnahme' : 'Ausgabe'} · {p.bereich_text} · Plan {s.plan.jahr}: <b>{euro(p.planwert)}</b> ({p.methode_text}{p.manuell ? ', von Hand geändert' : ''})</Text>

        {g ? (
          <div>
            <h4>Grundlage: Ist je Jahr</h4>
            {g.wenig_historie && <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.5rem' }}>
              Erst {g.jahre_anzahl} abgeschlossene{g.jahre_anzahl === 1 ? 's Jahr' : ' Jahre'} Historie – für dieses Konto gibt es keinen Trend und keine Trefferquote.
            </MessageStrip>}
            <div className="hh-roll">
              <table className="hh-tab">
                <thead><tr><th>Jahr</th><th className="z">Ist</th><th>In der Grundlage</th><th>Sondereffekt – Grund</th><th /></tr></thead>
                <tbody>
                  {s.jahre.map((j) => {
                    const sonder = g.sonder.find((x) => x.jahr === j);
                    const aus = g.ausreisser.find((x) => x.jahr === j);
                    const laeuft = j === s.basisjahr && s.stand_monat < 12;
                    return (
                      <tr key={j}>
                        <td>{j}{laeuft ? ' (läuft)' : ''}</td>
                        <td className="z">{euro(g.ist[j])}{laeuft && g.hoch ? <small className="portal-muted"> → {euro(g.hoch.wert)}</small> : null}</td>
                        <td>
                          {sonder ? <ObjectStatus state="Critical">Sondereffekt</ObjectStatus>
                            : g.zaehlt.includes(j) ? <ObjectStatus state="Positive">zählt</ObjectStatus> : <ObjectStatus state="None">zählt nicht</ObjectStatus>}
                          {aus && <ObjectStatus state="Information" style={{ marginLeft: '0.5rem' }} title={`Median ${euro(aus.median)}`}>Ausreißer? {prozent(aus.abweichung)}</ObjectStatus>}
                        </td>
                        <td>{edit ? <Input style={{ width: '16rem' }} value={gruende[j] ?? ''} placeholder="z. B. Dachsanierung" onInput={(e) => setGruende({ ...gruende, [j]: e.target.value })} /> : sonder?.grund ?? ''}</td>
                        <td>
                          {edit && (gruende[j] ?? '').trim() !== (sonder?.grund ?? '') && (gruende[j] ?? '').trim() !== '' && (
                            <Button design="Transparent" icon="accept" onClick={() => tun(() => api.post(`${HH}/sondereffekt`, { konto: p.konto, jahr: j, grund: gruende[j] }))}>Herausnehmen</Button>)}
                          {edit && sonder && <Button design="Transparent" icon="undo" onClick={() => tun(() => api.post(`${HH}/sondereffekt`, { konto: p.konto, jahr: j, grund: null }))}>Wieder aufnehmen</Button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : <MessageStrip design="Information" hideCloseButton>Für dieses Konto gibt es in den betrachteten Jahren keine Buchungen – der Planwert wird von Hand eingegeben.</MessageStrip>}

        {g && (
          <div>
            <h4>Methoden im Vergleich</h4>
            <div className="hh-roll">
              <table className="hh-tab">
                <thead><tr><th>Methode</th><th className="z">Wert für {s.plan.jahr}</th><th className="z">Treffsicherheit</th><th /></tr></thead>
                <tbody>
                  {g.fach !== null && <tr><td>{init.methoden.FACH}{g.beste === 'FACH' ? ' ★' : ''}</td><td className="z">{euro(g.fach)}</td><td className="z">–</td><td>aus den laufenden Verträgen</td></tr>}
                  {RECHEN_METHODEN.map((m) => (
                    <tr key={m}>
                      <td>{init.methoden[m]}{g.beste === m ? ' ★' : ''}</td>
                      <td className="z">{euro(g.werte[m])}</td>
                      <td className="z">{g.treffer[m] === null ? '–' : `${Math.round(g.treffer[m]!)} %`}</td>
                      <td>{g.werte[m] === null ? (m === 'TREND' ? 'weniger als drei abgeschlossene Jahre' : m === 'HOCH' ? 'im laufenden Jahr noch nichts gebucht' : 'keine Jahre in der Grundlage')
                        : m === 'HOCH' && g.hoch ? (g.hoch.art === 'VERLAUF' ? `Ist ÷ üblicher Anteil (${Math.round(g.hoch.anteil * 100)} % des Jahres)` : g.hoch.art === 'REST' ? 'Ist + üblicher Rest des Jahres'
                          : g.hoch.art === 'LINEAR' ? 'gleichmäßig hochgerechnet (kein Jahresverlauf)' : 'Jahr abgeschlossen') : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {g.pruefjahre.length > 0 && <Text className="portal-muted portal-small">Rückwirkend geprüft gegen {g.pruefjahre.slice().reverse().join(', ')}: Was hätte die Methode mit den damals vorliegenden Daten vorhergesagt?</Text>}
          </div>
        )}

        <div>
          <h4>Monatsverlauf {s.plan.jahr}</h4>
          <div className="hh-monate">
            {MONATE.map((m, i) => (
              <label key={m} className="hh-feld"><span>{m}</span>
                <Input value={monate[i]} readonly={!aenderbar} onInput={(e) => setMonate(monate.map((x, k) => (k === i ? e.target.value : x)))} />
              </label>
            ))}
          </div>
          <div className="portal-row" style={{ marginTop: '0.5rem' }}>
            <Text className="portal-muted portal-small">
              {p.monate_von_hand ? 'Von Hand festgelegt.' : p.monate_fest ? 'Mit dem Beschluss festgeschrieben.' : 'Berechnet aus dem Jahresverlauf der Vorjahre.'} Summe {euro(summe)}
              {passt ? '' : ` – der Planwert ist ${euro(p.planwert)}`}
            </Text>
            {aenderbar && <Button disabled={!passt} onClick={() => tun(() => api.put(`${HH}/plan/${s.plan.id}/monate`, { konto: p.konto, betraege: monate.map((m) => zahlLesen(m) ?? 0) }))}>Monate sichern</Button>}
            {aenderbar && p.monate_fest && <Button design="Transparent" onClick={() => tun(() => api.put(`${HH}/plan/${s.plan.id}/monate`, { konto: p.konto, betraege: null }))}>Wieder berechnen</Button>}
          </div>
        </div>

        <div className="hh-leiste" style={{ paddingBottom: 0 }}>
          {p.art === 'A' && (
            <label className="hh-feld"><span>Preissteigerung dieses Kontos (%) – leer = {zahlText(s.plan.preissteigerung)} % des Plans</span>
              <Input value={zuschlag} readonly={!aenderbar} onInput={(e) => setZuschlag(e.target.value)} /></label>
          )}
          <label className="hh-feld" style={{ flex: '1 1 16rem' }}><span>Notiz zum Konto (erscheint im PDF)</span>
            <Input style={{ width: '100%' }} value={notiz} readonly={!aenderbar} onInput={(e) => setNotiz(e.target.value)} /></label>
          {aenderbar && <Button onClick={() => tun(() => api.put(`${HH}/plan/${s.plan.id}/position`, { konto: p.konto, zuschlag: zuschlag.trim() ? zuschlag : null, notiz }))}>Sichern</Button>}
        </div>

        {edit && (
          <div className="hh-leiste" style={{ paddingBottom: 0 }}>
            <label className="hh-feld"><span>Vorgängerkonto (Historie davor zählt mit)</span>
              <Select style={{ minWidth: '16rem' }} onChange={(e) => setVorg((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                <Option data-k="" selected={!vorg}>– keines –</Option>
                {init.konten.filter((k) => k.konto !== p.konto && k.art === p.art).map((k) => <Option key={k.konto} data-k={k.konto} selected={k.konto === vorg}>{k.konto} {k.name}</Option>)}
              </Select></label>
            <label className="hh-feld"><span>neues Konto gilt ab Jahr</span><Input style={{ width: '6rem' }} value={abJahr} onInput={(e) => setAbJahr(e.target.value)} /></label>
            <Button onClick={() => tun(() => api.post(`${HH}/vorgaenger`, { konto: p.konto, vorgaenger: vorg || null, ab_jahr: vorg ? Number(abJahr) : null }))}>Zuordnung sichern</Button>
            {aenderbar && <Button design="Transparent" icon="delete" onClick={() => tun(() => api.post(`${HH}/plan/${s.plan.id}/position/entfernen`, { konto: p.konto }))}>Konto aus dem Plan nehmen</Button>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
