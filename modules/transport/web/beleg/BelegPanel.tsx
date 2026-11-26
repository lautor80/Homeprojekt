import { useState } from 'react';
import { Button, Icon, Link, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { dat, type AdrDD, type Auftrag, type Werte } from '../util';
import { BelegAnsicht } from './BelegAnsicht';
import type { BelegAnschrift } from './typen';
import { anschriftText, wertText, type FeldId, type KandidatWert, type Rueckfrage, type Wert } from './uebernahme';
import type { BelegMaske } from './useBelegMaske';

/**
 * Hinweisband „Aus Beleg vorbefüllt“ oben in der Neuanlage eines Frachtauftrags (AuftragDetail): Datei und Leseprofil, Zähler,
 * Dublettenwarnung, Rückfragen mit den Kandidaten (Wahl schreibt ins Feld), fehlende Felder, allgemeine Hinweise und die Ansicht
 * des Belegs mit dem gelesenen Text. Regeln: docs/euroflex-belegerfassung.md – nur Eindeutiges steht schon in der Maske.
 */
const WERTELISTE: Partial<Record<FeldId, keyof Werte>> = { fahrzeugtyp: 'FAHRZEUGTYP', ladegut: 'LADEGUT', ladeweise: 'LADEWEISE', palettentausch: 'PALETTENTAUSCH' };

export function BelegPanel({ beleg, a, adrDD, werte, bearbeitbar, onKontakt }: {
  beleg: BelegMaske;
  a: Auftrag;
  /** Kontakte und Wertelisten der Maske – für die Namen zu Schlüsseln */
  adrDD: AdrDD[];
  werte: Werte | null;
  bearbeitbar: boolean;
  /** „Kontakt anlegen“ mit der Anschrift laut Beleg (nur mit Recht) */
  onKontakt?: (b: BelegAnschrift) => void;
}) {
  const [details, setDetails] = useState(true);
  const [ansicht, setAnsicht] = useState(false);
  const s = beleg.stand;
  if (!s) return null;
  const v = s.quelle.vorschlag;
  const u = s.uebernahme;
  const offen = beleg.offen;

  /** Anzeige eines Formularwerts mit Namen statt Schlüssel (Kontakt, Werteliste) */
  const text = (id: FeldId, w: Wert): string => {
    if (w === null || w === '') return '';
    if (id === 'kunde') return adrDD.find((d) => d.key === String(w))?.text ?? `Kontakt ${w}`;
    const liste = WERTELISTE[id];
    return (liste && werte?.[liste].find((x) => x.key === String(w))?.text) || wertText(id, w);
  };
  // der Server liefert den Anzeigetext der Kandidaten; bei einem Konflikt (Wert stand schon im Feld) wird er hier gebildet
  const kandidatText = (r: Rueckfrage, k: KandidatWert) => (k.text && k.text !== wertText(r.id, k.wert) ? k.text : text(r.id, k.wert));
  const frage = (r: Rueckfrage) => (r.grund === 'konflikt'
    ? `Im Feld steht bereits „${text(r.id, r.vorhanden)}“ – im Beleg steht ${r.kandidaten.length > 1 ? 'anderes, und zwar mehrere Möglichkeiten' : 'etwas anderes'}. Bitte wählen; überschrieben wird nur auf Ihren Klick.`
    : r.kandidaten.length > 1 ? 'Im Beleg stehen mehrere Möglichkeiten – bitte wählen (oder den Wert unten im Feld von Hand eintragen).'
      : r.kandidaten.length === 1 ? 'Im Beleg steht ein unsicherer Wert – bitte prüfen und übernehmen (oder unten im Feld von Hand eintragen).'
        : 'Der Beleg ist hier nicht eindeutig – bitte unten im Feld von Hand eintragen.');

  const ordernummer = (a.ordernummer ?? '').trim() || v.ordernummer.wert || '';
  const kundeOffen = v.kunde.status !== 'eindeutig' && !a.kunde;
  const rahmen = { border: '1px solid var(--sapList_BorderColor)', borderRadius: 'var(--portal-radius, 0.75rem)' };
  const titel = { fontWeight: 'bold', display: 'block', marginBottom: '0.25rem' } as const;

  return (
    <div style={{ ...rahmen, borderLeft: '0.25rem solid var(--sapInformativeElementColor, #0070f2)', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', alignItems: 'center' }}>
        <Icon name="add-document" />
        <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
          <Text style={{ fontWeight: 'bold', display: 'block' }}>Aus Beleg vorbefüllt ({v.profil})</Text>
          <Text className="portal-muted portal-small" style={{ overflowWrap: 'anywhere' }}>
            {s.quelle.dateiName}
            {s.quelle.eingang ? ` · aus dem Posteingang${s.quelle.eingang.betreff ? ` (E-Mail „${s.quelle.eingang.betreff}“)` : ''}` : ''}
          </Text>
        </div>
        <ObjectStatus state="Positive">{u.uebernommen.length} übernommen</ObjectStatus>
        <ObjectStatus state={offen.length ? 'Critical' : 'None'} inverted={offen.length > 0}>
          {offen.length} {offen.length === 1 ? 'Rückfrage' : 'Rückfragen'} offen
        </ObjectStatus>
        <ObjectStatus state={u.fehlend.length ? 'Information' : 'None'}>{u.fehlend.length} nicht gefunden</ObjectStatus>
        <Button icon="show" onClick={() => setAnsicht(true)} tooltip="Beleg und gelesenen Text zur Kontrolle ansehen">Beleg ansehen</Button>
        <Link onClick={() => setDetails(!details)}>{details ? 'Einzelheiten ausblenden' : 'Einzelheiten anzeigen'}</Link>
      </div>

      {v.dubletten.map((d) => (
        <MessageStrip key={d.auftragsnr} design="Critical" hideCloseButton>
          Auftragsnr. Kunde {ordernummer} gibt es schon:{' '}
          <Link href={`/transport/auftraege/${encodeURIComponent(d.auftragsnr)}`} target="_blank">Auftrag {d.auftragsnr}</Link>
          {d.anlagedatum ? ` vom ${dat(d.anlagedatum)}` : ''}{d.kunde ? ` (${d.kunde})` : ''} – bitte prüfen, ob dieser Beleg schon erfasst ist. Speichern bleibt möglich.
        </MessageStrip>
      ))}

      <Text className="portal-muted portal-small">
        In der Maske steht nur, was im Beleg eindeutig zu lesen war (gekennzeichnet mit „aus Beleg“). Bitte alles prüfen – gespeichert wird erst mit „Speichern“.
        {' '}{s.quelle.eingang ? 'Danach wird die E-Mail aus dem Posteingang diesem Auftrag zugeordnet; ohne Speichern bleibt sie unverändert in der Prüfliste.'
          : s.quelle.datei ? 'Danach wird der Beleg an den Auftrag gehängt.' : ''}
      </Text>

      {details && offen.length > 0 && (
        <div>
          <Text style={titel}>Rückfragen ({offen.length})</Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {offen.map((r) => (
              <div key={r.id} style={{ ...rahmen, borderColor: 'var(--sapCriticalElementColor, #e76500)', overflow: 'hidden' }}>
                <div style={{ padding: '0.5rem 0.75rem' }}>
                  <Text style={{ fontWeight: 'bold', display: 'block' }}>{r.bezeichnung}</Text>
                  <Text className="portal-small" style={{ display: 'block' }}>{frage(r)}</Text>
                  {r.hinweis && <Text className="portal-muted portal-small" style={{ display: 'block' }}>{r.hinweis}</Text>}
                </div>
                {r.kandidaten.map((k, i) => (
                  <div key={i} className="portal-ad__zeile" style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                    <Icon name="document-text" />
                    <div style={{ minWidth: 0 }}>
                      <Text style={{ overflowWrap: 'anywhere' }}><b>{kandidatText(r, k)}</b></Text>
                      {k.herkunft && <div className="portal-muted portal-small" style={{ overflowWrap: 'anywhere' }}>Im Beleg: „{k.herkunft}“</div>}
                    </div>
                    {bearbeitbar && <Button design="Transparent" icon="accept" onClick={() => beleg.waehlen(r, k)}>{r.grund === 'konflikt' ? 'Aus Beleg übernehmen' : 'Wählen'}</Button>}
                  </div>
                ))}
                {r.grund === 'konflikt' && bearbeitbar && (
                  <div style={{ padding: '0.25rem 0.5rem', borderTop: '1px solid var(--sapList_BorderColor)', textAlign: 'right' }}>
                    <Button design="Transparent" onClick={() => beleg.behalten(r)}>Eingabe „{text(r.id, r.vorhanden)}“ behalten</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {details && v.kunde.status !== 'eindeutig' && v.kundeImBeleg.length > 0 && (
        <div>
          <Text style={titel}>Auftraggeber laut Beleg</Text>
          {v.kundeImBeleg.map((b, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.75rem', alignItems: 'center' }}>
              <Text style={{ overflowWrap: 'anywhere' }}>{anschriftText(b)}</Text>
              {kundeOffen && bearbeitbar && onKontakt && <Button design="Transparent" icon="add-contact" onClick={() => onKontakt(b)}>Als Kontakt anlegen…</Button>}
            </div>
          ))}
          {kundeOffen && (
            <Text className="portal-muted portal-small" style={{ display: 'block' }}>
              Dazu wurde kein eindeutiger Kontakt gefunden – den Kunden unten unter „Kunde“ über Name oder Ort suchen{onKontakt ? ' oder als neuen Kontakt anlegen' : ''}.
            </Text>
          )}
        </div>
      )}

      {details && u.fehlend.length > 0 && (
        <div>
          <Text style={titel}>Nicht im Beleg gefunden – bitte von Hand nachtragen ({u.fehlend.length})</Text>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {u.fehlend.map((f) => (
              <li key={f.ids.join('|')}>
                <Text>{f.bezeichnung}{f.hinweis && <span className="portal-muted"> – {f.hinweis}</span>}</Text>
              </li>
            ))}
          </ul>
        </div>
      )}

      {details && v.hinweise.length > 0 && (
        <div>
          <Text style={titel}>Hinweise zum Beleg</Text>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {v.hinweise.map((h, i) => <li key={i}><Text>{h}</Text></li>)}
          </ul>
        </div>
      )}

      {ansicht && <BelegAnsicht quelle={s.quelle} onClose={() => setAnsicht(false)} />}
    </div>
  );
}

/** Kennzeichnung unter einem Feld der Maske: offene Rückfrage (deutlich) bzw. „aus Beleg“ (dezent) */
export function BelegKennzeichen({ art }: { art: 'frage' | 'beleg' | null | undefined }) {
  if (!art) return null;
  if (art === 'frage') return <div style={{ marginTop: '0.125rem' }}><ObjectStatus state="Critical">Rückfrage offen – oben wählen oder hier eintragen</ObjectStatus></div>;
  return (
    <div className="portal-muted portal-small" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.125rem' }}>
      <Icon name="add-document" style={{ width: '0.75rem', height: '0.75rem' }} />aus Beleg
    </div>
  );
}
