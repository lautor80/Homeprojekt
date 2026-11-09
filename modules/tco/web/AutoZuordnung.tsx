import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Icon, Input, MessageStrip, ObjectStatus, Option, SegmentedButton,
  SegmentedButtonItem, Select, Text,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { H, RG_STATUS, dat, eur, wtag, zeit, type Buchung } from './util';
import './halle.css';

/**
 * Automatische Zuordnung offener Hallenbuchungen zu Rechnungen.
 * Aufbau: Kennzahlen · Filterleiste · je Tag eine aufklappbare Karte, darin je Person (Ziel-Rechnung, Summe) die Buchungen.
 */
type AutoBuchung = Buchung & { auswahl: boolean; hinweis: string; ziel?: string; platz?: string | null };
interface ZielInfo { rgnr: string; status: string; positionen: number }
interface AutoKunde { kunde: string; name: string; ziele: string[]; zielInfo?: ZielInfo[]; ziel: string; buchungen: AutoBuchung[] }
type Filter = 'ALLE' | 'FEHLER' | 'ABO' | 'EINZEL';

const key = (b: { bid: string; datum: string }) => `${b.bid}|${b.datum}`;
const klein = () => window.matchMedia?.('(max-width: 700px)').matches ?? false;

export function AutoDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (t: string) => void }) {
  const [daten, setDaten] = useState<AutoKunde[] | null>(null);
  const [zukunft, setZukunft] = useState(false);
  const [filter, setFilter] = useState<Filter>('ALLE');
  const [suche, setSuche] = useState('');
  const [offen, setOffen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const laden = () => {
    setDaten(null); setError(null);
    api.get<AutoKunde[]>(`${H}/auto`).then((d) => {
      setDaten(d);
      // Tage mit Preisfehlern gleich aufgeklappt – dort ist Handlungsbedarf
      setOffen(new Set(d.flatMap((k) => k.buchungen.filter((b) => b.fehler && !b.zukunft).map((b) => b.datum))));
    }).catch((e) => setError(e.message));
  };
  useEffect(() => { if (open) laden(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /** sichtbare Buchungen eines Kunden (Zeitraum + Filter) */
  const sichtbar = (k: AutoKunde) => k.buchungen.filter((b) => (zukunft || !b.zukunft)
    && (filter === 'ALLE' || (filter === 'FEHLER' ? !!b.fehler : filter === 'ABO' ? b.art === 'Abo' : b.art === 'Einzel')));
  const kunden = useMemo(() => (daten ?? []).filter((k) => sichtbar(k).length
    && (!suche.trim() || k.name.toLowerCase().includes(suche.trim().toLowerCase()))), [daten, zukunft, filter, suche]); // eslint-disable-line react-hooks/exhaustive-deps

  const setK = (kunde: string, fn: (k: AutoKunde) => AutoKunde) => setDaten((d) => d!.map((k) => (k.kunde === kunde ? fn(k) : k)));
  const auswahlSetzen = (kunde: string, keys: Set<string>, an: boolean) =>
    setK(kunde, (k) => ({ ...k, buchungen: k.buchungen.map((b) => (keys.has(key(b)) ? { ...b, auswahl: an } : b)) }));
  const alleSetzen = (an: boolean | 'vorschlag') => setDaten((d) => d!.map((k) => {
    const s = new Set(sichtbar(k).map(key));
    if (!kunden.some((x) => x.kunde === k.kunde)) return k;
    return { ...k, buchungen: k.buchungen.map((b) => (s.has(key(b)) ? { ...b, auswahl: an === 'vorschlag' ? !b.zukunft && !b.fehler : an } : b)) };
  }));
  // erste Stufe: Tag, zweite Stufe: Person (Ziel-Rechnung bleibt je Person)
  const tage = useMemo(() => {
    const m = new Map<string, { k: AutoKunde; b: AutoBuchung[] }[]>();
    for (const k of kunden) {
      for (const b of sichtbar(k)) {
        const l = m.get(b.datum) ?? [];
        const e = l.find((x) => x.k.kunde === k.kunde);
        if (e) e.b.push(b); else l.push({ k, b: [b] });
        m.set(b.datum, l);
      }
    }
    return [...m].sort(([a], [b]) => a.localeCompare(b))
      .map(([datum, personen]) => ({ datum, personen: personen.sort((a, b) => a.k.name.localeCompare(b.k.name, 'de')) }));
  }, [kunden, zukunft, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Auswahl über mehrere Personen (Tageskopf) */
  const tagSetzen = (personen: { k: AutoKunde; b: AutoBuchung[] }[], an: boolean) => setDaten((d) => d!.map((k) => {
    const keys = new Set(personen.filter((x) => x.k.kunde === k.kunde).flatMap((x) => x.b.map(key)));
    return keys.size ? { ...k, buchungen: k.buchungen.map((b) => (keys.has(key(b)) ? { ...b, auswahl: an } : b)) } : k;
  }));
  const umschalten = (kunde: string) => setOffen((o) => { const n = new Set(o); if (n.has(kunde)) n.delete(kunde); else n.add(kunde); return n; });

  // Kennzahlen über alle ausgewählten Buchungen (auch außerhalb des Filters)
  const kz = useMemo(() => {
    const alle = daten ?? [];
    const gewaehlt = alle.flatMap((k) => k.buchungen.filter((b) => b.auswahl).map((b) => ({ k, b })));
    const kundenMit = alle.filter((k) => k.buchungen.some((b) => b.auswahl));
    return {
      anzahl: gewaehlt.length,
      gesamt: alle.reduce((s, k) => s + k.buchungen.filter((b) => zukunft || !b.zukunft).length, 0),
      summe: gewaehlt.reduce((s, x) => s + x.b.betrag, 0),
      kunden: kundenMit.length,
      neu: kundenMit.filter((k) => k.ziel === 'NEU').length,
      ergaenzt: kundenMit.filter((k) => k.ziel !== 'NEU').length,
      fehler: alle.reduce((s, k) => s + k.buchungen.filter((b) => b.fehler && (zukunft || !b.zukunft)).length, 0),
      fehlerGewaehlt: gewaehlt.filter((x) => x.b.fehler).length,
    };
  }, [daten, zukunft]);

  async function buchen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${H}/auto`, {
        kunden: daten!.map((k) => ({ kunde: k.kunde, ziel: k.ziel, buchungen: k.buchungen.filter((b) => b.auswahl).map((b) => ({ bid: b.bid, datum: b.datum, ziel: b.ziel })) })),
      });
      onDone(r.text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return createPortal(
    <Dialog open={open} stretch={klein()} headerText="Automatische Zuordnung" onClose={onClose} className="portal-az__dialog"
            style={klein() ? undefined : { width: 'min(70rem, 96vw)', height: '90vh' }}
            footer={<Bar startContent={
              <Text className="portal-az__fuss">
                <b>{kz.anzahl}</b> Buchung(en) · <b>{kz.kunden}</b> Kunde(n) · {kz.neu} neue Rechnung(en), {kz.ergaenzt} ergänzt · <b>{eur(kz.summe)}</b>
              </Text>
            } endContent={<>
              <Button design="Emphasized" icon="accept" loading={busy} disabled={!kz.anzahl || busy} onClick={buchen}>Zuordnen und buchen</Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      <div className="portal-az">
        {error && <MessageStrip design="Negative" onClose={() => setError(null)}>{error}</MessageStrip>}

        {/* Kennzahlen */}
        <div className="portal-az__kpis">
          <div className="portal-az__kpi"><span>Ausgewählt</span><b>{kz.anzahl} <small>von {kz.gesamt}</small></b></div>
          <div className="portal-az__kpi"><span>Summe</span><b>{eur(kz.summe)}</b></div>
          <div className="portal-az__kpi"><span>Rechnungen</span><b>{kz.neu} <small>neu</small> · {kz.ergaenzt} <small>ergänzt</small></b></div>
          <div className={`portal-az__kpi${kz.fehler ? ' portal-az__kpi--warn' : ''}`}>
            <span>Preisfehler</span><b>{kz.fehler}{kz.fehlerGewaehlt ? <small> ({kz.fehlerGewaehlt} gewählt)</small> : null}</b>
          </div>
        </div>

        {/* Filterleiste */}
        <div className="portal-az__leiste">
          <SegmentedButton onSelectionChange={(e) => setZukunft((e.detail.selectedItems[0] as HTMLElement).dataset.k === 'z')}>
            <SegmentedButtonItem data-k="h" selected={!zukunft}>Bis heute</SegmentedButtonItem>
            <SegmentedButtonItem data-k="z" selected={zukunft}>Inkl. Zukunft</SegmentedButtonItem>
          </SegmentedButton>
          <SegmentedButton onSelectionChange={(e) => setFilter((e.detail.selectedItems[0] as HTMLElement).dataset.k as Filter)}>
            <SegmentedButtonItem data-k="ALLE" selected={filter === 'ALLE'}>Alle</SegmentedButtonItem>
            <SegmentedButtonItem data-k="EINZEL" selected={filter === 'EINZEL'}>Einzel</SegmentedButtonItem>
            <SegmentedButtonItem data-k="ABO" selected={filter === 'ABO'}>Abo</SegmentedButtonItem>
            <SegmentedButtonItem data-k="FEHLER" selected={filter === 'FEHLER'} icon="alert">Fehler</SegmentedButtonItem>
          </SegmentedButton>
          <Input placeholder="Kunde suchen" value={suche} onInput={(e) => setSuche(e.target.value)} className="portal-az__suche" showClearIcon />
          <div className="portal-az__leiste-rechts">
            <Button design="Transparent" icon="favorite" tooltip="Vorschlag: alle Buchungen bis heute ohne Preisfehler" onClick={() => alleSetzen('vorschlag')}>Vorschlag</Button>
            <Button design="Transparent" icon="multiselect-all" onClick={() => alleSetzen(true)}>Alle</Button>
            <Button design="Transparent" icon="multiselect-none" onClick={() => alleSetzen(false)}>Keine</Button>
            <Button design="Transparent" icon={offen.size ? 'collapse-all' : 'expand-all'} tooltip={offen.size ? 'Alle zuklappen' : 'Alle aufklappen'}
                    onClick={() => setOffen(offen.size ? new Set() : new Set(tage.map((t) => t.datum)))} />
          </div>
        </div>

        {!daten && !error && <BusyIndicator active style={{ display: 'block', padding: '3rem 0' }} />}
        {daten && !kunden.length && (
          <div className="portal-az__leer">
            <Icon name="complete" />
            <Text>{daten.length ? 'Keine Buchungen für diese Auswahl.' : 'Keine offenen Buchungen – alles zugeordnet.'}</Text>
          </div>
        )}

        {/* Tage → Personen → Buchungen */}
        <div className="portal-az__liste">
          {tage.map(({ datum, personen }) => {
            const alle = personen.flatMap((x) => x.b);
            const gew = alle.filter((b) => b.auswahl);
            const alleGew = gew.length === alle.length;
            const fehler = alle.filter((b) => b.fehler).length;
            const auf = offen.has(datum);
            return (
              <section key={datum} className={`portal-az__kunde${gew.length ? ' portal-az__kunde--aktiv' : ''}`}>
                <div className="portal-az__kopf portal-az__kopf--tag">
                  <CheckBox checked={alleGew && alle.length > 0} indeterminate={gew.length > 0 && !alleGew}
                            accessibleName={`${dat(datum)} auswählen`} onChange={(e) => tagSetzen(personen, e.target.checked)} />
                  <button type="button" className="portal-az__name" onClick={() => umschalten(datum)} aria-expanded={auf}>
                    <Icon name={auf ? 'navigation-down-arrow' : 'navigation-right-arrow'} />
                    <span>
                      <span className="portal-az__name-text">{wtag(datum)}, {dat(datum)}</span>
                      <span className="portal-az__sub">
                        {personen.length} Person(en) · {gew.length} von {alle.length} Buchung(en) gewählt
                        {alle.some((b) => b.art === 'Abo') && ` · ${alle.filter((b) => b.art === 'Abo').length} Abo`}
                        {fehler > 0 && <ObjectStatus state="Negative" showDefaultIcon>{fehler} Preisfehler</ObjectStatus>}
                      </span>
                    </span>
                  </button>
                  <div className="portal-az__summe">{eur(gew.reduce((t, b) => t + b.betrag, 0))}</div>
                </div>

                {auf && personen.map(({ k, b: s }) => {
                  const sk = new Set(s.map(key));
                  const pg = s.filter((b) => b.auswahl);
                  const pAlle = pg.length === s.length;
                  const info = (z: string) => k.zielInfo?.find((x) => x.rgnr === z);
                  return (
                    <div key={k.kunde} className="portal-az__person">
                      <div className="portal-az__kopf portal-az__kopf--person">
                        <CheckBox checked={pAlle && s.length > 0} indeterminate={pg.length > 0 && !pAlle}
                                  accessibleName={`${k.name} am ${dat(datum)} auswählen`} onChange={(e) => auswahlSetzen(k.kunde, sk, e.target.checked)} />
                        <span className="portal-az__name portal-az__name--person">
                          <Icon name="person-placeholder" />
                          <span>
                            <span className="portal-az__name-text">{k.name}</span>
                            <span className="portal-az__sub">{pg.length} von {s.length} gewählt</span>
                          </span>
                        </span>
                        <div className="portal-az__ziel">
                          <Select accessibleName="Ziel-Rechnung (gilt für alle Tage der Person)"
                                  onChange={(e) => setK(k.kunde, (x) => ({ ...x, ziel: (e.detail.selectedOption as HTMLElement).dataset.z! }))}>
                            <Option data-z="NEU" icon="add-document" selected={k.ziel === 'NEU'}>Neue Rechnung</Option>
                            {k.ziele.map((z) => {
                              const i = info(z);
                              return <Option key={z} data-z={z} icon="sales-document" selected={k.ziel === z}>
                                {z}{i ? ` · ${RG_STATUS[i.status] ?? i.status}, ${i.positionen} Pos.` : ''}
                              </Option>;
                            })}
                          </Select>
                        </div>
                        <div className="portal-az__summe">{eur(pg.reduce((t, b) => t + b.betrag, 0))}</div>
                      </div>
                      <div className="portal-az__buchungen" role="list">
                        {s.map((b) => (
                          <div key={key(b)} role="listitem"
                               onClick={(e) => { if ((e.target as HTMLElement).tagName !== 'UI5-CHECKBOX') auswahlSetzen(k.kunde, new Set([key(b)]), !b.auswahl); }}
                               className={`portal-az__zeile${b.auswahl ? ' portal-az__zeile--an' : ''}${b.fehler ? ' portal-az__zeile--fehler' : ''}`}>
                            <CheckBox checked={b.auswahl} accessibleName={`${dat(b.datum)} ${zeit(b.time_start)}`}
                                      onChange={(e) => auswahlSetzen(k.kunde, new Set([key(b)]), e.target.checked)} />
                            <span className="portal-az__datum"><b>{wtag(b.datum)}</b> {dat(b.datum)}</span>
                            <span className="portal-az__zeit">{zeit(b.time_start)}–{zeit(b.time_ende)}</span>
                            <span className="portal-az__platz">{b.platz || '–'}</span>
                            <span className="portal-az__art">
                              <ObjectStatus state={b.art === 'Abo' ? 'Information' : 'None'} inverted={b.art === 'Abo'}>{b.art}</ObjectStatus>
                              {b.zukunft && <ObjectStatus state="Critical">Zukunft</ObjectStatus>}
                            </span>
                            <span className="portal-az__hinweis" title={b.hinweis}>{b.hinweis || b.text || ''}</span>
                            <span className="portal-az__betrag">{b.fehler ? '–' : eur(b.betrag)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>

        <Text className="portal-muted portal-small">
          Gruppiert nach Tag, darin nach Person. Vorschlag: alle Buchungen bis heute ohne Preisfehler. Ziel je Person (gilt für alle Tage):
          jüngste Rechnung „In Bearbeitung“, sonst eine neue Rechnung.
          Abos werden einmal je Serie abgerechnet.
        </Text>
      </div>
    </Dialog>,
    document.body,
  );
}
