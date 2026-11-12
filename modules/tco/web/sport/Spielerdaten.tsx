import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { BusyIndicator, Button, CheckBox, Icon, Input, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { useAblageZiel } from '@core/ablage';
import { AppPage } from '@core/components/AppPage';
import { Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen } from '../util';
import './spielerdaten.css';

/**
 * Spielerdaten aus nuLiga (#162, Sportwart): Die im Verbandsportal heruntergeladene Datei „Mitgliederdaten“ (CSV) wird per
 * Drag & Drop abgelegt und mit den aktiven Mitgliedern abgeglichen. Die Vorschau zeigt Treffer mit ID-Nr. und LK (alt → neu),
 * unsichere Treffer zum Prüfen sowie Mitglieder bzw. Personen ohne Gegenstück; übernommen wird erst mit „Übernehmen“.
 */
const S = `${TCO}/sport/spielerdaten`;
const lk = (v: number | null | undefined) => (v == null ? '–' : `LK ${v.toFixed(1).replace('.', ',')}`);

interface Zeile { adrnr: string; name: string; mitglnrn: string; geburtsdatum: string | null; id_nr: string | null; lk: number | null; lk_stand: string | null; verlauf: { jahr: number; lk: number }[] }
interface Stand { zeilen: Zeile[]; anzahl: { mitglieder: number; mitId: number; mitLk: number }; letzterAbgleich: string | null }
interface Treffer {
  adrnr: string; zeile: number; name: string; mitglnrn: string; geburtsdatum: string | null; inDatei: string; art: string; sicher: boolean; hinweis: string | null;
  id_alt: string | null; id_neu: string | null; lk_alt: number | null; lk_neu: number | null; aenderung: boolean;
}
interface Rest { name: string; geburtsdatum: string | null; id_nr: string | null; lk: number | null }
interface Abgleich {
  treffer: Treffer[]; ohneTreffer: (Rest & { adrnr: string })[]; nurDatei: (Rest & { zeile: number })[]; personen: number;
  anzahl: { aenderungen: number; unveraendert: number; pruefen: number; ohneTreffer: number; nurDatei: number };
}
const schluessel = (t: { adrnr: string; zeile: number }) => `${t.adrnr}|${t.zeile}`;

function Tabelle({ kopf, children, leer }: { kopf: string[]; children: ReactNode; leer?: string }) {
  return (
    <div className="portal-sd__rahmen">
      <table className="portal-sd__tabelle">
        <thead><tr>{kopf.map((k) => <th key={k}>{k}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {leer && <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem 1rem' }}>{leer}</Text>}
    </div>
  );
}
const Wechsel = ({ alt, neu }: { alt: string; neu: string }) => (alt === neu ? <span>{neu}</span>
  : <span><span className="portal-muted" style={{ textDecoration: alt === '–' ? 'none' : 'line-through' }}>{alt}</span> → <b>{neu}</b></span>);

export function Spielerdaten() {
  const edit = useCan()('tco.sport:edit');
  const [stand, setStand] = useState<Stand | null>(null);
  const [a, setA] = useState<Abgleich | null>(null);
  const [datei, setDatei] = useState<{ name: string; inhalt: string } | null>(null);
  const [wahl, setWahl] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ueber, setUeber] = useState(false);
  const [suche, setSuche] = useState('');
  const [alle, setAlle] = useState(false);
  const eingabe = useRef<HTMLInputElement>(null);

  const laden = () => api.get<Stand>(S).then(setStand).catch((e) => setError(e.message));
  useEffect(() => { laden(); }, []);

  async function ablegen(f: File | undefined) {
    if (!f || !edit) return;
    setError(null);
    if (!/\.(csv|txt)$/i.test(f.name)) { setError('Bitte die CSV-Datei aus nuLiga ablegen (Mitglieder → „Download Mitgliederdaten (Excel, csv)“). Eine Excel-Datei bitte als CSV speichern.'); return; }
    if (f.size > 5_000_000) { setError('Die Datei ist zu groß.'); return; }
    setBusy(true);
    try {
      const inhalt = (await dateiLesen(f)).replace(/^data:[^,]*,/, '');
      const r = await api.post<Abgleich>(`${S}/abgleich`, { datei: inhalt });
      setDatei({ name: f.name, inhalt });
      setA(r);
      // vorausgewählt: sichere Treffer mit Änderung; unsichere müssen bewusst angehakt werden
      setWahl(new Set(r.treffer.filter((t) => t.sicher && t.aenderung).map(schluessel)));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  // Ablagefeld des Portals und Strg+V: Datei landet ebenfalls hier
  useAblageZiel(edit ? { titel: 'Spielerdaten (nuLiga)', annehmen: (files) => { ablegen(files[0]); } } : null);

  async function uebernehmen() {
    if (!a || !datei) return;
    setBusy(true); setError(null);
    try {
      const auswahl = a.treffer.filter((t) => wahl.has(schluessel(t))).map((t) => ({ adrnr: t.adrnr, zeile: t.zeile }));
      const r = await api.post<{ text: string }>(`${S}/uebernehmen`, { datei: datei.inhalt, name: datei.name, auswahl });
      toast(r.text, 8000);
      setA(null); setDatei(null); setWahl(new Set());
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const drop = (ev: DragEvent) => { ev.preventDefault(); ev.stopPropagation(); setUeber(false); ablegen(ev.dataTransfer.files[0]); };
  const umschalten = (t: Treffer, an: boolean) => { const n = new Set(wahl); if (an) n.add(schluessel(t)); else n.delete(schluessel(t)); setWahl(n); };

  const mitAenderung = a?.treffer.filter((t) => t.sicher && t.aenderung) ?? [];
  const pruefen = a?.treffer.filter((t) => !t.sicher) ?? [];
  const s = suche.trim().toLowerCase();
  const zeilen = (stand?.zeilen ?? []).filter((z) => (alle || z.id_nr || z.lk != null) && (!s || `${z.name} ${z.id_nr ?? ''} ${z.mitglnrn}`.toLowerCase().includes(s)));

  const trefferZeile = (t: Treffer) => (
    <tr key={schluessel(t)}>
      <td><CheckBox checked={wahl.has(schluessel(t))} disabled={busy} accessibleName={`${t.name} übernehmen`} onChange={(e) => umschalten(t, e.target.checked)} /></td>
      <td><b>{t.name}</b><div className="portal-muted portal-small">{t.geburtsdatum ? dat(t.geburtsdatum) : 'ohne Geburtsdatum'}{t.mitglnrn ? ` · Nr. ${t.mitglnrn}` : ''}</div></td>
      <td>{t.inDatei}{t.hinweis && <div className="portal-small" style={{ color: 'var(--sapCriticalTextColor)' }}>{t.hinweis}</div>}</td>
      <td><Wechsel alt={t.id_alt ?? '–'} neu={t.id_neu ?? '–'} /></td>
      <td><Wechsel alt={lk(t.lk_alt)} neu={lk(t.lk_neu)} /></td>
    </tr>
  );

  return (
    <AppPage title="Spielerdaten (nuLiga)" subtitle="ID-Nr. und Leistungsklasse (LK) der Mitglieder mit der Verbandsliste abgleichen">
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem', whiteSpace: 'pre-line' }}>{error}</MessageStrip>}

      {edit && (
        <Section title="Abgleich mit nuLiga">
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>
            1. In nuLiga (stb.liga.nu) unter <b>Mitglieder</b> auf <b>Download Mitgliederdaten (Excel, csv)</b> klicken und die Datei speichern.
            {' '}2. Die Datei hier ablegen. 3. Vorschau prüfen und übernehmen. Die LK ändert sich jedes Jahr – den Abgleich einfach wiederholen.
          </Text>
          <div className={`portal-ablagebox${ueber ? ' portal-ablagebox--ueber' : ''}`} role="button" tabIndex={0}
               onClick={() => eingabe.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') eingabe.current?.click(); }}
               onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setUeber(true); }} onDragLeave={() => setUeber(false)} onDrop={drop}>
            <Icon name="upload" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b style={{ color: 'var(--sapTextColor)' }}>{datei ? datei.name : 'Mitgliederdaten aus nuLiga hier ablegen'}</b>
              <div>{datei ? 'Andere Datei ablegen oder anklicken, um neu abzugleichen.' : 'CSV-Datei hierher ziehen oder anklicken, um sie auszuwählen. Es wird noch nichts gespeichert.'}</div>
            </div>
            {busy && <BusyIndicator active size="S" />}
          </div>
          <input ref={eingabe} type="file" hidden accept=".csv,.txt,text/csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; ablegen(f); }} />
        </Section>
      )}

      {a && (
        <Section title="Vorschau" actions={<>
          <Button design="Emphasized" icon="accept" disabled={busy || !wahl.size} onClick={uebernehmen}>{wahl.size} übernehmen</Button>
          <Button design="Transparent" disabled={busy} onClick={() => { setA(null); setDatei(null); }}>Verwerfen</Button>
        </>}>
          <div className="portal-sd__zahlen">
            <ObjectStatus state="Information" inverted>{a.personen} Personen in der Datei</ObjectStatus>
            <ObjectStatus state="Positive" inverted>{a.anzahl.aenderungen} Treffer mit Änderung</ObjectStatus>
            <ObjectStatus state="None" inverted>{a.anzahl.unveraendert} unverändert</ObjectStatus>
            {a.anzahl.pruefen > 0 && <ObjectStatus state="Critical" inverted>{a.anzahl.pruefen} bitte prüfen</ObjectStatus>}
            <ObjectStatus state="None" inverted>{a.anzahl.ohneTreffer} Mitglieder ohne Treffer</ObjectStatus>
            <ObjectStatus state="None" inverted>{a.anzahl.nurDatei} nur in nuLiga</ObjectStatus>
          </div>

          {pruefen.length > 0 && (
            <>
              <h4 className="portal-sd__titel">Bitte prüfen ({pruefen.length}) – wird nur übernommen, wenn angehakt</h4>
              <Tabelle kopf={['', 'Mitglied im Portal', 'Person in nuLiga', 'ID-Nr.', 'LK']}>{pruefen.map(trefferZeile)}</Tabelle>
            </>
          )}
          <h4 className="portal-sd__titel">Treffer mit Änderung ({mitAenderung.length})
            {mitAenderung.length > 0 && (
              <Button design="Transparent" style={{ marginLeft: '0.5rem' }} onClick={() => {
                const allean = mitAenderung.every((t) => wahl.has(schluessel(t)));
                const n = new Set(wahl); mitAenderung.forEach((t) => (allean ? n.delete(schluessel(t)) : n.add(schluessel(t)))); setWahl(n);
              }}>alle / keine</Button>
            )}
          </h4>
          <Tabelle kopf={['', 'Mitglied im Portal', 'Person in nuLiga', 'ID-Nr.', 'LK']} leer={mitAenderung.length ? undefined : 'Keine Änderungen – ID-Nr. und LK sind bereits aktuell.'}>
            {mitAenderung.map(trefferZeile)}
          </Tabelle>

          <details className="portal-sd__mehr">
            <summary>Mitglieder ohne Treffer in nuLiga ({a.ohneTreffer.length})</summary>
            <Tabelle kopf={['Mitglied', 'Geburtsdatum', 'ID-Nr. (gespeichert)', 'LK (gespeichert)']}>
              {a.ohneTreffer.map((m) => <tr key={m.adrnr}><td>{m.name}</td><td>{dat(m.geburtsdatum)}</td><td>{m.id_nr ?? '–'}</td><td>{lk(m.lk)}</td></tr>)}
            </Tabelle>
          </details>
          <details className="portal-sd__mehr">
            <summary>Nur in nuLiga, kein aktives Mitglied im Portal ({a.nurDatei.length})</summary>
            <Tabelle kopf={['Person', 'Geburtsdatum', 'ID-Nr.', 'LK']}>
              {a.nurDatei.map((p) => <tr key={p.zeile}><td>{p.name}</td><td>{dat(p.geburtsdatum)}</td><td>{p.id_nr ?? '–'}</td><td>{lk(p.lk)}</td></tr>)}
            </Tabelle>
          </details>
        </Section>
      )}

      <Section title="Aktueller Stand" count={stand ? zeilen.length : undefined}
               status={stand && <Text className="portal-muted portal-small">{stand.anzahl.mitId} von {stand.anzahl.mitglieder} aktiven Mitgliedern mit ID-Nr., {stand.anzahl.mitLk} mit LK{stand.letzterAbgleich ? ` · letzter Abgleich ${dat(stand.letzterAbgleich)}` : ''}</Text>}
               actions={<>
                 <Input placeholder="Name oder ID-Nr." value={suche} showClearIcon style={{ width: '14rem' }} onInput={(e) => setSuche(e.target.value)} />
                 <CheckBox text="auch ohne ID-Nr./LK" checked={alle} onChange={(e) => setAlle(e.target.checked)} />
               </>}>
        {!stand ? <BusyIndicator active style={{ display: 'block', padding: '1rem' }} /> : (
          <Tabelle kopf={['Mitglied', 'Geburtsdatum', 'ID-Nr.', 'LK', 'Stand', 'Vorjahre']}
                   leer={zeilen.length ? undefined : stand.anzahl.mitId || stand.anzahl.mitLk ? 'Keine Mitglieder zu dieser Suche.' : 'Noch keine Spielerdaten – bitte die Datei aus nuLiga ablegen.'}>
            {zeilen.map((z) => (
              <tr key={z.adrnr}>
                <td>{z.name}{z.mitglnrn && <span className="portal-muted portal-small"> · Nr. {z.mitglnrn}</span>}</td>
                <td>{dat(z.geburtsdatum)}</td><td>{z.id_nr ?? '–'}</td><td><b>{lk(z.lk)}</b></td><td>{dat(z.lk_stand)}</td>
                <td className="portal-muted">{z.verlauf.filter((v) => v.jahr < new Date().getFullYear()).map((v) => `${v.jahr}: ${lk(v.lk)}`).join(' · ')}</td>
              </tr>
            ))}
          </Tabelle>
        )}
      </Section>
    </AppPage>
  );
}
