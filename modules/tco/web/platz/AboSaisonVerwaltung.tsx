import { useEffect, useState } from 'react';
import { Varianten, feld as variantenFeld } from '@core/components/Varianten';
import { Bar, BusyIndicator, Button, DatePicker, Dialog, Icon, Input, Label, MessageStrip, ObjectStatus, Option, SegmentedButton, SegmentedButtonItem, Select, Text } from '@ui5/webcomponents-react';
import type { ReactNode } from 'react';
import '../sport/spielerdaten.css';
import { api } from '@core/api';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { TCO, dat } from '../util';
import { uhrzeitOrdnung, uhrzeitText, wochentagText } from './abospalten';
import { STATUS, type Saison } from './AboBewerbung';

/**
 * Abo-Saison verwalten (Kassenwart, #11) – in der Platzverwaltung im Reiter „Abos“ (bis dahin unter „Platz buchen → Abo-Bewerbung“).
 * Lädt die Verwaltungsdaten selbst; Fehler stehen als Meldung über der Section, Erfolge als Toast.
 */
const PB = `${TCO}/platz`;

interface VWunsch { id: number; art: string; name: string; mitglied: boolean; platz: string; text: string; status: string; angelegt: string; mail_fehler: string | null; wartende: number; position: number | null; wochentag: number; von: string; bis: string; kosten: string | null }
interface Verwaltung { saison: Saison | null; wuensche: VWunsch[] }

function Tabelle({ kopf, children }: { kopf: string[]; children: ReactNode }) {
  return (
    <div className="portal-tabrahmen">
      <table className="portal-sd__tabelle"><thead><tr>{kopf.map((k, i) => <th key={i}>{k}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </div>
  );
}

export function AboSaisonVerwaltung() {
  const [v, setV] = useState<Verwaltung | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = async () => {
    try { setV(await api.get<Verwaltung>(`${PB}/admin/abosaison`)); } catch (e) { setFehler((e as Error).message); }
  };
  useEffect(() => { laden(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tun = async (fn: () => Promise<{ text?: string }>) => {
    setBusy(true); setFehler(null);
    try { const x = await fn(); toast(x.text ?? 'Gespeichert.', 7000); await laden(); }
    catch (e) { setFehler((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.75rem' }}>{fehler}</MessageStrip>}
      {v ? <AboVerwaltung v={v} busy={busy} tun={tun} /> : !fehler && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
    </>
  );
}

/**
 * Kassenwart: Saison eröffnen (immer aktuelles Jahr / Folgejahr), Fristen und E-Mail-Pause einstellen, Übersicht als Tabellen:
 * Abos des Vorjahres (Bestätigung) und Warteliste in ihrer Reihenfolge – jeweils mit Freigabe.
 */
function AboVerwaltung({ v, busy, tun }: { v: Verwaltung; busy: boolean; tun: (fn: () => Promise<{ text?: string }>) => Promise<void> }) {
  const j = new Date().getFullYear();
  const s = v.saison;
  const NEU = { name: `${j}/${j + 1}`, von: `${j}-09-15`, bis: `${j + 1}-04-30`, bestaetigen_bis: `${j}-07-30`, nachruecken_ab: `${j}-08-15`, annahme_tage: '7', mail_pause_bis: '' };
  const [neu, setNeu] = useState(!s);
  const [f, setF] = useState(() => (s ? { name: s.name, von: s.von, bis: s.bis, bestaetigen_bis: s.bestaetigen_bis, nachruecken_ab: s.nachruecken_ab, annahme_tage: String(s.annahme_tage), mail_pause_bis: s.mail_pause_bis ?? '' } : NEU));
  const [vj, setVj] = useState({ von: `${j - 1}-09-15`, bis: `${j}-04-30` });
  // vor jedem Schritt, der E-Mails auslöst: nachfragen
  const [frage, setFrage] = useState<null | 'eroeffnen' | 'lauf'>(null);
  const feld = (k: keyof typeof f, label: string, breite = '9.5rem', fest = false) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
      <Label>{label}</Label>
      {k === 'name' || k === 'annahme_tage'
        ? <Input readonly={fest} value={f[k]} style={{ width: breite }} onInput={(e) => setF({ ...f, [k]: (e.target as unknown as { value: string }).value })} />
        : <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={f[k]} style={{ width: breite }}
                      onChange={(e) => (e.detail.valid || !e.detail.value) && setF({ ...f, [k]: e.detail.value ?? '' })} />}
    </span>
  );
  const vjFeld = (k: 'von' | 'bis', label: string) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}><Label>{label}</Label>
      <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={vj[k]} style={{ width: '9.5rem' }}
                  onChange={(e) => e.detail.valid && e.detail.value && setVj({ ...vj, [k]: e.detail.value })} /></span>
  );
  const daten = { ...f, annahme_tage: Number(f.annahme_tage) || 7, mail_pause_bis: f.mail_pause_bis || null };
  const ausfuehren = (mail: boolean) => {
    const was = frage;
    setFrage(null);
    if (was === 'eroeffnen') return tun(async () => { const x = await api.post<{ text: string }>(`${PB}/admin/abosaison`, { ...daten, vorjahr_von: vj.von, vorjahr_bis: vj.bis, mail }); setNeu(false); return x; });
    return tun(() => api.post<{ text?: string }>(`${PB}/admin/abosaison/lauf`, { mail }));
  };
  const lebt = (w: VWunsch) => !['ZURUECKGEZOGEN', 'ABGELEHNT', 'VERFALLEN', 'ABGEGEBEN'].includes(w.status);
  const zeit = (a: VWunsch, b: VWunsch) => a.platz.localeCompare(b.platz) || a.wochentag - b.wochentag || a.von.localeCompare(b.von) || (a.position ?? 0) - (b.position ?? 0);
  const abos = v.wuensche.filter((w) => w.art === 'BESTAETIGUNG' && lebt(w)).sort(zeit);
  const warte = v.wuensche.filter((w) => w.art === 'BEWERBUNG' && lebt(w)).sort(zeit);
  // eine Tabelle, Umschalter im Kopf; jede Spalte filter- und sortierbar
  const [sicht, setSicht] = useState<'abos' | 'warte'>('abos');
  const [sort, setSort] = useState<{ k: string; ab: boolean } | null>(null);
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [liste, setListe] = useState<VWunsch | null>(null);
  /** Warteliste zu einer Stunde: wartende Bewerbungen auf demselben Platz und Tag, deren Zeit sich überschneidet */
  const wartelisteZu = (w: VWunsch) => warte.filter((x) => x.status === 'WARTET' && x.platz === w.platz && x.wochentag === w.wochentag && x.von < w.bis && x.bis > w.von)
    .sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  const istWarte = sicht === 'warte';
  interface Spalte { k: string; titel: string; text: (w: VWunsch) => string; ordnung?: (w: VWunsch) => string | number; zelle?: (w: VWunsch) => ReactNode }
  const spalten: Spalte[] = [
    // Wochentag und Uhrzeit getrennt – je eigene Spalte zum Filtern und Sortieren (#11)
    { k: 'tag', titel: 'Wochentag', text: (w) => wochentagText(w.wochentag), ordnung: (w) => w.wochentag },
    { k: 'uhrzeit', titel: 'Uhrzeit', text: (w) => uhrzeitText(w.von, w.bis), ordnung: (w) => uhrzeitOrdnung(w.von, w.bis) },
    { k: 'platz', titel: 'Platz', text: (w) => w.platz },
    ...(istWarte ? [{ k: 'position', titel: 'Position', text: (w: VWunsch) => (w.position != null ? `${w.position} von ${w.wartende}` : '–'), ordnung: (w: VWunsch) => w.position ?? 999 }] : []),
    { k: 'name', titel: istWarte ? 'Interessent' : 'Abonnent', text: (w) => w.name },
    { k: 'mitglied', titel: 'Mitglied', text: (w) => (w.mitglied ? 'Mitglied' : 'kein Mitglied') },
    { k: 'stand', titel: 'Stand', text: (w) => STATUS[w.status] ?? w.status,
      zelle: (w) => <ObjectStatus state={['BESTAETIGT', 'ANGENOMMEN'].includes(w.status) ? 'Critical' : w.status === 'FREIGEGEBEN' ? 'Positive' : 'None'}>{STATUS[w.status] ?? w.status}</ObjectStatus> },
    istWarte
      ? { k: 'angelegt', titel: 'Beworben am', text: (w) => dat(w.angelegt), ordnung: (w) => w.angelegt }
      : { k: 'warteliste', titel: 'Warteliste', text: (w) => String(wartelisteZu(w).length), ordnung: (w) => wartelisteZu(w).length,
        zelle: (w) => { const n = wartelisteZu(w).length; return n ? <Button design="Transparent" icon="group" tooltip="Warteliste zu dieser Stunde anzeigen" onClick={() => setListe(w)}>{n}</Button> : '–'; } },
    { k: 'hinweis', titel: 'Hinweis', text: (w) => [w.kosten, w.mail_fehler].filter(Boolean).join(' · ') || '–' },
  ];
  const basis = istWarte ? warte : abos;
  // Filter je Spalte: Auswahlliste mit den in der Tabelle vorkommenden Werten (in der Reihenfolge der Spalte)
  const passt = (w: VWunsch) => spalten.every((sp) => !filter[sp.k] || sp.text(w) === filter[sp.k]);
  const werte = (x: Spalte) => [...new Map([...basis].sort((a, b) => {
    const va = (x.ordnung ?? x.text)(a), vb = (x.ordnung ?? x.text)(b);
    return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'de', { numeric: true });
  }).map((w) => [x.text(w), true])).keys()];
  const sp = sort ? spalten.find((x) => x.k === sort.k) : undefined;
  const wert = (w: VWunsch) => (sp ? (sp.ordnung ?? sp.text)(w) : 0);
  const zeilen = basis.filter(passt).sort((x, y) => {
    if (!sp) return 0;
    const a = wert(x), b = wert(y);
    const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'de', { numeric: true });
    return sort!.ab ? c : -c;
  });
  const aktionen = (w: VWunsch) => (
    <td style={{ whiteSpace: 'nowrap' }}>
      {['BESTAETIGT', 'ANGENOMMEN'].includes(w.status) && <Button design="Emphasized" disabled={busy} onClick={() => tun(() => api.post<{ text?: string }>(`${PB}/admin/abowunsch/freigeben`, { id: w.id }))}>Freigeben</Button>}
      {w.status !== 'FREIGEGEBEN' && (
        <Button design="Transparent" disabled={busy} tooltip={w.art === 'BEWERBUNG' ? 'Bewerbung ablehnen: Sie verlässt die Warteliste, die Nächsten rücken auf. Es wird nichts gebucht oder storniert.'
          : 'Abo für diese Saison nicht verlängern: Die Stunde wird frei und geht an die Warteliste. Es wird nichts storniert.'}
                onClick={() => tun(() => api.post<{ text?: string }>(`${PB}/admin/abowunsch/abweisen`, { id: w.id }))}>Ablehnen</Button>
      )}
    </td>
  );
  return (
    <Section title="Abo-Saison verwalten (Kassenwart)" flush actions={s && !neu ? <Button design="Transparent" onClick={() => { setF(NEU); setNeu(true); }}>Neue Saison eröffnen</Button> : undefined}>
      <div className="portal-abo__detail">
        <span style={{ display: 'inline-flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {feld('name', 'Saison', '8rem', true)}{feld('von', 'Beginn')}{feld('bis', 'Ende')}{feld('bestaetigen_bis', 'Bestätigen bis')}{feld('nachruecken_ab', 'Nachrücken ab')}{feld('annahme_tage', 'Annahmefrist (Tage)', '8rem')}
          {feld('mail_pause_bis', 'E-Mail-Pause bis')}
          {neu && (
            <>
              {vjFeld('von', 'Abos des Vorjahres von')}{vjFeld('bis', 'bis')}
            </>
          )}
          {neu
            ? <Button design="Emphasized" disabled={busy} onClick={() => setFrage('eroeffnen')}>Saison eröffnen</Button>
            : <Button disabled={busy} onClick={() => tun(() => api.put<{ text?: string }>(`${PB}/admin/abosaison/${s!.id}`, daten))}>Fristen speichern</Button>}
          {s && !neu && <Button design="Transparent" disabled={busy} onClick={() => setFrage('lauf')}>Fällige Schritte jetzt ausführen</Button>}
          {neu && s && <Button design="Transparent" onClick={() => { setF({ name: s.name, von: s.von, bis: s.bis, bestaetigen_bis: s.bestaetigen_bis, nachruecken_ab: s.nachruecken_ab, annahme_tage: String(s.annahme_tage), mail_pause_bis: s.mail_pause_bis ?? '' }); setNeu(false); }}>Abbrechen</Button>}
        </span>
        {frage && (
          <MessageStrip design="Critical" hideCloseButton>
            {frage === 'eroeffnen' ? 'Sollen die bisherigen Abonnenten per E-Mail gebeten werden, ihr Abo zu bestätigen?' : 'Sollen die Betroffenen (Erinnerung, Angebote aus der Warteliste) per E-Mail informiert werden?'}{' '}
            <Button design="Emphasized" disabled={busy} onClick={() => ausfuehren(true)}>Ja, E-Mails senden</Button>{' '}
            <Button disabled={busy} onClick={() => ausfuehren(false)}>Ohne E-Mail ausführen</Button>{' '}
            <Button design="Transparent" onClick={() => setFrage(null)}>Abbrechen</Button>
          </MessageStrip>
        )}
        <Text className="portal-muted portal-small">
          {neu ? 'Beim Eröffnen werden die Hallenabos des Vorjahres zur Bestätigung vorgemerkt – es wird nichts gebucht. Training wird nicht abgefragt; es wird über die festen Belegungen der Platzverwaltung geblockt. Ist der Nachrück-Termin schon vorbei (laufende Saison), entfällt die Vormerkung; freie Stunden können dann sofort beworben werden. '
            : ''}
          E-Mail-Pause: Bis einschließlich dieses Datums ruht der automatische Lauf (keine Erinnerung, kein Verfall, keine Angebote, keine E-Mails). „Ablehnen“ nimmt einen Eintrag aus dem Verfahren – die Stunde wird frei bzw. die Warteliste rückt auf; gebucht oder storniert wird dabei nichts.
        </Text>
      </div>
      {s && (
        <div className="portal-abo__detail">
          <span style={{ display: 'inline-flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
<Varianten repid="tco.abo.verwaltung" ansicht={{ sicht, sort, filter }} onAnwenden={(a) => { setSicht(variantenFeld(a, 'sicht', sicht)); setSort(variantenFeld(a, 'sort', sort)); setFilter(variantenFeld(a, 'filter', filter)); }} />
            <SegmentedButton onSelectionChange={(e) => { setSicht((e.detail.selectedItems[0] as HTMLElement).dataset.k as 'abos'); setSort(null); setFilter({}); }}>
              <SegmentedButtonItem data-k="abos" selected={!istWarte}>Abos des Vorjahres ({abos.length})</SegmentedButtonItem>
              <SegmentedButtonItem data-k="warte" selected={istWarte}>Warteliste ({warte.length})</SegmentedButtonItem>
            </SegmentedButton>
            {(sort || Object.values(filter).some(Boolean)) && <Button design="Transparent" icon="clear-filter" onClick={() => { setSort(null); setFilter({}); }}>Filter und Sortierung zurücksetzen</Button>}
            {zeilen.length !== basis.length && <Text className="portal-muted">{zeilen.length} von {basis.length}</Text>}
          </span>
          {basis.length ? (
            <div className="portal-tabrahmen">
              <table className="portal-sd__tabelle">
                <thead>
                  <tr>
                    {spalten.map((x) => (
                      <th key={x.k} style={{ cursor: 'pointer', userSelect: 'none' }} title="Sortieren" onClick={() => setSort(sort?.k === x.k ? (sort.ab ? { k: x.k, ab: false } : null) : { k: x.k, ab: true })}>
                        {x.titel}{sort?.k === x.k && <Icon name={sort.ab ? 'sort-ascending' : 'sort-descending'} style={{ marginInlineStart: '0.25rem', width: '0.8rem', height: '0.8rem' }} />}
                      </th>
                    ))}
                    <th />
                  </tr>
                  <tr>
                    {spalten.map((x) => (
                      <th key={x.k} style={{ padding: '0.2rem 0.4rem' }}>
                        <Select accessibleName={`${x.titel} filtern`} style={{ width: '100%', minWidth: '6rem' }}
                                onChange={(e) => setFilter({ ...filter, [x.k]: (e.detail.selectedOption as HTMLElement).dataset.w ?? '' })}>
                          <Option data-w="" selected={!filter[x.k]}>Alle</Option>
                          {werte(x).map((w) => <Option key={w} data-w={w} selected={filter[x.k] === w}>{w}</Option>)}
                        </Select>
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {zeilen.map((w) => <tr key={w.id}>{spalten.map((x) => <td key={x.k}>{x.zelle ? x.zelle(w) : x.text(w)}</td>)}{aktionen(w)}</tr>)}
                </tbody>
              </table>
              {!zeilen.length && <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem' }}>Kein Eintrag passt zum Filter.</Text>}
            </div>
          ) : <Text className="portal-muted">{istWarte ? 'Noch keine Bewerbungen.' : 'Keine Abos zur Bestätigung vorgemerkt.'}</Text>}
        </div>
      )}
      {liste && (
        <Dialog open headerText={`Warteliste: ${liste.text} · ${liste.platz}`} onClose={() => setListe(null)} style={{ width: 'min(44rem, 96vw)' }}
                footer={<Bar endContent={<Button onClick={() => setListe(null)}>Schließen</Button>} />}>
          <Text style={{ display: 'block', marginBottom: '0.5rem' }}>Abo von {liste.name} ({STATUS[liste.status] ?? liste.status}). Reihenfolge: Mitglieder zuerst, sonst nach Eingang.</Text>
          <Tabelle kopf={['Position', 'Interessent', '', 'Gewünschte Zeit', 'Beworben am']}>
            {wartelisteZu(liste).map((x) => <tr key={x.id}><td>{x.position ?? '–'}</td><td>{x.name}</td><td>{x.mitglied ? 'Mitglied' : 'kein Mitglied'}</td><td>{x.text}</td><td>{dat(x.angelegt)}</td></tr>)}
          </Tabelle>
        </Dialog>
      )}
    </Section>
  );
}
