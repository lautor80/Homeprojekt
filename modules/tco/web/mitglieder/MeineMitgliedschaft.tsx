import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalyticalTable, Bar, BusyIndicator, Button, CheckBox, Dialog, Label, MessageStrip, ObjectStatus, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { PdfDialog } from '@core/components/PdfDialog';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { useSperre, SperrHinweis } from '@core/sperre';
import { TCO, dat } from '../util';
import type { Person, Vertrag } from './typen';
import { GruppenAuswahl, type BaumGruppe } from './GruppenTab';
import { VertragsBaum } from './VertragsBaum';
import { MEIN_TITEL, MeinVorgangDialog, type MeinTyp } from './MeinVorgang';

/**
 * „Meine Mitgliedschaft“: eigene Stammdaten sehen, Kontaktdaten und (bei Lastschrift) die eigene Bankverbindung ändern,
 * Mitgliedschaft oder einzelne Verträge zum Jahresende kündigen – auch für Personen, die über das Mitglied zahlen.
 * Der Server kennt nur das dem Benutzer zugeordnete Mitglied; andere Daten sind hier nicht erreichbar.
 */
const MG = `${TCO}/mitglieder/meine`;

interface Meine {
  mitglied: {
    adrnr: string; anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string; telefon: string; mobil: string; email: string;
    geburtsdatum: string | null; eintritt: string | null; austritt: string | null; mitglnrn: string; datenschutz: boolean; bildrechte: boolean; aktiv: boolean;
  };
  titel: string; trainer: boolean; kanal: string;
  /** Spielerdaten aus nuLiga (#162) */
  spieler?: { id_nr: string; lk: number | null; lk_stand: string | null };
  bank: { zahlungsart_txt: string; zahlungsweise_txt: string; iban: string; bic: string; bank: string; kontoinhaber: string; zahler: string | null; zahltSelbst: boolean; lastschrift: boolean; mandatsref: string };
  familie: Person[]; vertraege: (Vertrag & { kuendbar: boolean; endeBei: string })[];
  /** Vertragsbaum: Verträge aller verknüpften Personen; kündbar nur eigene und die von Personen, die über mich zahlen */
  vertraegeFamilie: (Vertrag & { kuendbar: boolean; endeBei: string })[]; kuendigung: { mitgliedschaft: string; jugend: string; heute: string }; gekuendigt: boolean;
}
type Kontakt = { strasse: string; plz: string; ort: string; telefon: string; mobil: string; email: string; bildrechte: boolean };

export function MeineMitgliedschaft() {
  const [d, setD] = useState<Meine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kein, setKein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<'kontakt' | 'bank' | null>(null);
  const [kuend, setKuend] = useState<{ art: 'MITGLIEDSCHAFT' } | { art: 'VERTRAG'; v: Vertrag & { endeBei: string } } | null>(null);
  const [pdf, setPdf] = useState<{ url: string; name: string; server?: boolean } | null>(null);
  // Sperre, solange ein Änderungs- oder Kündigungsdialog offen ist (Vorstand kann dann nicht gleichzeitig pflegen und umgekehrt)
  /** geführter Vorgang (#154): Beitrag wechseln, Jugendtraining abschließen, kündigen */
  const [vorgang, setVorgang] = useState<MeinTyp | null>(null);
  const sperre = useSperre('MITGLIED', d?.mitglied.adrnr ?? null, !!dlg || !!kuend || !!vorgang,
    { bezeichnung: d ? `Mitglied ${d.mitglied.vorname} ${d.mitglied.nachname} (Meine Mitgliedschaft)` : 'Mitglied' });
  const [docs, setDocs] = useState<{ dokumente: { id: number; titel: string; erstellt: string; typ: string; datei: string }[]; hinweis: string | null } | null>(null);
  useEffect(() => { api.get<typeof docs>(`${MG}/dokumente`).then(setDocs).catch(() => setDocs({ dokumente: [], hinweis: 'Dokumente konnten nicht geladen werden.' })); }, []);
  const gesperrt = sperre.zustand === 'fremd';

  // eigene Gruppen (Mitgliedergruppen): ansehen, sich selbst ein- und austragen
  const [gr, setGr] = useState<{ gruppen: BaumGruppe[]; meine: { id: number; rolle: string | null }[] } | null>(null);
  const [grBusy, setGrBusy] = useState(false);
  const gruppenLaden = () => api.get<NonNullable<typeof gr>>(`${MG}/gruppen`).then(setGr).catch(() => setGr(null));
  useEffect(() => { gruppenLaden(); }, []);
  async function gruppeSetzen(gruppe: number, entfernen: boolean) {
    setGrBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${MG}/gruppen`, { gruppe, entfernen });
      toast(r.text, 5000);
    } catch (e) { setError((e as Error).message); } finally { await gruppenLaden(); setGrBusy(false); }
  }
  const laden = () => api.get<Meine>(MG).then(setD).catch((e) => { const x = e as { status?: number; message: string }; if (x.status === 403) setKein(x.message); else setError(x.message); });
  useEffect(() => { laden(); }, []);

  async function aktion(fn: () => Promise<{ text: string; pdf?: string; dateiname?: string; hinweise?: string[] }>) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      toast(r.text, 8000);
      setDlg(null); setKuend(null);
      if (r.pdf) {
        // Kündigungsbestätigung zum Drucken/Speichern anzeigen
        const bytes = Uint8Array.from(atob(r.pdf), (c) => c.charCodeAt(0));
        setPdf({ url: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), name: r.dateiname ?? 'Kuendigungsbestaetigung.pdf' });
      }
      if (r.hinweise?.length) setError(r.hinweise.join('\n'));
      await laden();
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }

  if (kein) return <AppPage title="Meine Mitgliedschaft"><MessageStrip design="Information" hideCloseButton>{kein}</MessageStrip></AppPage>;
  if (!d) return <AppPage title="Meine Mitgliedschaft">{error ? <MessageStrip design="Negative">{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem' }} />}</AppPage>;
  const m = d.mitglied;
  // eigene laufende Verträge (auch bereits gekündigte, die noch nicht beendet sind) – enden mit der Mitgliedschaft
  const eigene = d.vertraege.filter((v) => v.laeuft && v.eigen);
  const vertraegeBaum = d.vertraegeFamilie ?? d.vertraege;

  return (
    <AppPage title="Meine Mitgliedschaft" subtitle="Eigene Daten sehen und pflegen">
      {error && !dlg && !kuend && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      <ObjectHeader title={`${m.vorname} ${m.nachname}`} subtitle={`Mitgliedsnummer ${m.mitglnrn || m.adrnr}`}
                    status={m.austritt ? <ObjectStatus state="Critical" inverted>Austritt zum {dat(m.austritt)}</ObjectStatus> : <ObjectStatus state="Positive" inverted>aktives Mitglied</ObjectStatus>}
>
        <Attributes>
          <Attribute label="Eintritt">{dat(m.eintritt)}</Attribute>
          <Attribute label="Geburtsdatum">{dat(m.geburtsdatum)}</Attribute>
          {d.trainer && <Attribute label="Funktion">Trainer im Jugendtraining</Attribute>}
          {d.spieler?.lk != null && <Attribute label="Leistungsklasse">LK {d.spieler.lk.toFixed(1).replace('.', ',')}{d.spieler.lk_stand ? ` (Stand ${dat(d.spieler.lk_stand)})` : ''}</Attribute>}
          {d.spieler?.id_nr && <Attribute label="ID-Nr. (nuLiga)">{d.spieler.id_nr}</Attribute>}
          <Attribute label="Bevorzugter Versandweg">{d.kanal === 'W' ? 'WhatsApp' : d.kanal === 'E' ? 'E-Mail' : 'E-Mail/Post'}</Attribute>
        </Attributes>
      </ObjectHeader>

      <Section title="Was möchtest du ändern?">
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button icon="switch-classes" onClick={() => { setError(null); setVorgang('BEITRAGSWECHSEL'); }}>{MEIN_TITEL.BEITRAGSWECHSEL}</Button>
          <Button icon="physical-activity" onClick={() => { setError(null); setVorgang('JUGENDTRAINING'); }}>{MEIN_TITEL.JUGENDTRAINING}</Button>
          <Button icon="decline" onClick={() => { setError(null); setVorgang('KUENDIGUNG'); }}>{MEIN_TITEL.KUENDIGUNG}</Button>
        </div>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Schritt für Schritt: Angaben wählen, prüfen, bestätigen – für dich und für Personen, deren Beiträge über dich laufen. Du erhältst eine Bestätigung per E-Mail.
        </Text>
      </Section>

      <Section title="Kontaktdaten" actions={<Button icon="edit" disabled={gesperrt} onClick={() => { setError(null); setDlg('kontakt'); }}>Ändern</Button>}>
        <Attributes>
          <Attribute label="Anschrift">{m.strasse}<br />{m.plz} {m.ort}</Attribute>
          <Attribute label="Telefon">{m.telefon || '–'}</Attribute>
          <Attribute label="Mobil">{m.mobil || '–'}</Attribute>
          <Attribute label="E-Mail">{m.email || '–'}</Attribute>
          <Attribute label="Bildrechte">{m.bildrechte ? 'Veröffentlichung von Fotos erlaubt' : 'keine Veröffentlichung von Fotos'}</Attribute>
        </Attributes>
        <Text className="portal-muted portal-small">Name, Geburtsdatum und Eintritt ändert der Vorstand – bitte bei Bedarf melden.</Text>
      </Section>

      <Section title="Beitragszahlung" actions={d.bank.zahltSelbst && d.bank.lastschrift ? <Button icon="edit" onClick={() => { setError(null); setDlg('bank'); }}>Bankverbindung ändern</Button> : undefined}>
        <Attributes>
          <Attribute label="Zahlungsart">{d.bank.zahlungsart_txt}{d.bank.zahlungsweise_txt ? ` · ${d.bank.zahlungsweise_txt}` : ''}</Attribute>
          {d.bank.zahler ? <Attribute label="Beiträge zahlt">{d.bank.zahler}</Attribute> : <>
            <Attribute label="IBAN">{d.bank.iban || '–'}</Attribute>
            <Attribute label="Kreditinstitut">{d.bank.bank || '–'}</Attribute>
            <Attribute label="Kontoinhaber">{d.bank.kontoinhaber}</Attribute>
            {d.bank.mandatsref && <Attribute label="SEPA-Mandat">{d.bank.mandatsref}</Attribute>}
          </>}
        </Attributes>
      </Section>

      <Section title="Verträge" count={vertraegeBaum.filter((v) => v.laeuft).length}>
        <VertragsBaum personen={d.familie.length ? d.familie : [{ adrnr: m.adrnr, name: `${m.vorname} ${m.nachname}`, mitglnrn: m.mitglnrn, geburtsdatum: m.geburtsdatum, eintritt: m.eintritt, austritt: m.austritt, rolle: 'Mitglied' }]}
                      vertraege={vertraegeBaum} ich={m.adrnr} ichText={`${m.vorname} ${m.nachname} (ich)`} aktionenBreite={190}
                      vertragAktion={(v) => (v.kuendbar && !gesperrt
                        ? <Button design="Transparent" icon="decline" tooltip={`Kündigung zum ${dat(v.endeBei)}`} onClick={() => { setError(null); setKuend({ art: 'VERTRAG', v }); }}>Vertrag kündigen</Button>
                        : null)} />
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Der Baum zeigt deine Verträge und die der verknüpften Personen (Zahler oben, darunter wer über ihn zahlt). Kündigen kannst du deine
          eigenen Verträge und die von Personen, die über dich zahlen.
        </Text>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.25rem' }}>
          Mitgliedschaft und Verträge enden zum 31.12. des laufenden Jahres ({dat(d.kuendigung.mitgliedschaft)}), Jugendtraining zum nächsten 30.09. ({dat(d.kuendigung.jugend)}).
          Kündigungsdatum ist das Tagesdatum; die Bestätigung wird gedruckt und per E-Mail zugestellt.
        </Text>
      </Section>

      {gr && gr.gruppen.length > 0 && (
        <Section title="Gruppen" count={gr.meine.length}>
          <GruppenAuswahl baum={gr.gruppen} zugeordnet={gr.meine} edit={!gesperrt && !grBusy} rolleAenderbar={false} leer="Es gibt noch keine Gruppen."
                          setzen={(gruppe, body) => gruppeSetzen(gruppe, !!body.entfernen)} />
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
            Hier trägst du dich selbst in Gruppen und Mannschaften ein oder aus – auch in mehrere nebeneinander. Mit einer Untergruppe
            gehörst du automatisch zu den Gruppen darüber. Veranstaltungen deiner Gruppen stehen im Vereinskalender. Eine Rolle
            (z. B. Mannschaftsführer) vergibt der Verein.
          </Text>
        </Section>
      )}

      <Section title="Dokumente" count={docs?.dokumente.length ?? undefined} flush>
        {!docs ? <BusyIndicator active style={{ display: 'block', padding: '1rem' }} />
          : docs.hinweis ? <Text className="portal-muted" style={{ display: 'block', padding: '0.75rem 1rem' }}>{docs.hinweis}</Text>
            : <AnalyticalTable data={docs.dokumente} minRows={1} visibleRows={Math.min(Math.max(docs.dokumente.length, 1), 10)} rowHeight={44} noDataText="Keine Dokumente abgelegt"
                               columns={[
                                 { Header: 'Datum', accessor: 'erstellt', width: 110, Cell: ({ value }: Cell) => dat(value) },
                                 { Header: 'Dokument', accessor: 'titel', minWidth: 220 },
                                 { Header: 'Art', accessor: 'typ', width: 200 },
                                 {
                                   Header: '', id: 'oeffnen', width: 120,
                                   Cell: ({ row }: Cell) => <Button design="Transparent" icon="show" onClick={() => setPdf({ url: `${MG}/dokumente/${row.original.id}`, name: row.original.datei || `${row.original.titel}.pdf`, server: true })}>Öffnen</Button>,
                                 },
                               ]} />}
      </Section>

      {d.familie.length > 0 && (
        <Section title="Familie" count={d.familie.length}>
          <Attributes>
            {d.familie.map((p) => <Attribute key={p.adrnr} label={p.rolle}>{p.name}{p.austritt ? ` (Austritt ${dat(p.austritt)})` : ''}</Attribute>)}
          </Attributes>
        </Section>
      )}

      {dlg === 'kontakt' && <KontaktDialog start={m} busy={busy || gesperrt || sperre.zustand === 'laden'} error={gesperrt ? sperre.text : error} onClose={() => setDlg(null)} onSave={(k) => aktion(() => api.put(`${MG}/kontakt`, k))} />}
      {dlg === 'bank' && <BankDialog busy={busy || gesperrt || sperre.zustand === 'laden'} error={gesperrt ? sperre.text : error} onClose={() => setDlg(null)} onSave={(b) => aktion(() => api.put(`${MG}/bank`, b))} />}
      {kuend && <KuendigungDialog k={kuend} info={d.kuendigung} vertraege={eigene} busy={busy || gesperrt || sperre.zustand === 'laden'} error={gesperrt ? sperre.text : error} onClose={() => setKuend(null)}
                                  onConfirm={(grund) => aktion(() => api.post(`${MG}/kuendigung`, {
                                    art: kuend.art, grund: grund || null, bestaetigung: true,
                                    ...(kuend.art === 'VERTRAG' ? { adrnr: kuend.v.adrnr, vertragnr: kuend.v.vertragnr } : {}),
                                  }))} />}
      {vorgang && (
        <MeinVorgangDialog typ={vorgang} gesperrt={gesperrt ? sperre.text : null}
                           kuendigung={{
                             gekuendigt: d.gekuendigt, ende: d.kuendigung.mitgliedschaft, eigene, kuendbar: vertraegeBaum.filter((v) => v.kuendbar), ich: m.adrnr, ichText: `${m.vorname} ${m.nachname} (ich)`,
                             personen: d.familie.length ? d.familie : [{ adrnr: m.adrnr, name: `${m.vorname} ${m.nachname}`, mitglnrn: m.mitglnrn, geburtsdatum: m.geburtsdatum, eintritt: m.eintritt, austritt: m.austritt, rolle: 'Mitglied' }],
                           }}
                           onClose={(geaendert) => { setVorgang(null); if (geaendert) laden(); }} />
      )}
      {pdf && <PdfDialog url={pdf.url} title={pdf.server ? pdf.name : 'Kündigungsbestätigung'} filename={pdf.name} onClose={() => { if (!pdf.server) URL.revokeObjectURL(pdf.url); setPdf(null); }} />}
    </AppPage>
  );
}

function KontaktDialog({ start, busy, error, onClose, onSave }: { start: Kontakt; busy: boolean; error: string | null; onClose: () => void; onSave: (k: Kontakt) => void }) {
  const [k, setK] = useState<Kontakt>({ strasse: start.strasse, plz: start.plz, ort: start.ort, telefon: start.telefon, mobil: start.mobil, email: start.email, bildrechte: start.bildrechte });
  const set = (f: keyof Kontakt) => (v: string) => setK({ ...k, [f]: v });
  return createPortal(
    <Dialog open headerText="Kontaktdaten ändern" style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<><Button design="Emphasized" disabled={busy} onClick={() => onSave(k)}>Sichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <FormGrid>
        <TextField label="Straße und Hausnummer" required value={k.strasse} onChange={set('strasse')} wide />
        <TextField label="PLZ" required value={k.plz} onChange={set('plz')} />
        <TextField label="Ort" required value={k.ort} onChange={set('ort')} />
        <TextField label="Telefon" value={k.telefon} onChange={set('telefon')} type="Tel" />
        <TextField label="Mobil" value={k.mobil} onChange={set('mobil')} type="Tel" />
        <TextField label="E-Mail" value={k.email} onChange={set('email')} type="Email" wide />
        <CheckField label="Fotos von mir dürfen im Rahmen der Vereinsarbeit veröffentlicht werden" checked={k.bildrechte} onChange={(v) => setK({ ...k, bildrechte: v })} />
      </FormGrid>
    </Dialog>,
    document.body,
  );
}

function BankDialog({ busy, error, onClose, onSave }: { busy: boolean; error: string | null; onClose: () => void; onSave: (b: { iban: string; bic: string; bank: string }) => void }) {
  const [b, setB] = useState({ iban: '', bic: '', bank: '' });
  const [ok, setOk] = useState(false);
  return createPortal(
    <Dialog open headerText="Bankverbindung ändern" style={{ width: 'min(32rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<><Button design="Emphasized" disabled={busy || !b.iban.trim() || !ok} onClick={() => onSave(b)}>Sichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <FormGrid columns={1}>
        <TextField label="Neue IBAN" required value={b.iban} onChange={(v) => setB({ ...b, iban: v })} placeholder="DE.." />
        <TextField label="BIC (optional)" value={b.bic} onChange={(v) => setB({ ...b, bic: v })} />
        <TextField label="Kreditinstitut (optional)" value={b.bank} onChange={(v) => setB({ ...b, bank: v })} />
        <CheckBox text="Ich ermächtige den Verein, die Beiträge künftig von diesem Konto per SEPA-Lastschrift einzuziehen (bestehendes Mandat gilt weiter)." checked={ok} onChange={(e) => setOk(e.target.checked)} />
      </FormGrid>
    </Dialog>,
    document.body,
  );
}

function KuendigungDialog({ k, info, vertraege, busy, error, onClose, onConfirm }: {
  k: { art: 'MITGLIEDSCHAFT' } | { art: 'VERTRAG'; v: Vertrag & { endeBei: string } }; info: { mitgliedschaft: string; jugend: string; heute: string };
  vertraege: Vertrag[]; busy: boolean; error: string | null; onClose: () => void; onConfirm: (grund: string) => void;
}) {
  const [grund, setGrund] = useState('');
  const [ok, setOk] = useState(false);
  const laufende = vertraege.filter((v) => v.laeuft && !v.vertragende);
  return createPortal(
    <Dialog open headerText={k.art === 'MITGLIEDSCHAFT' ? 'Mitgliedschaft kündigen' : 'Vertrag kündigen'} style={{ width: 'min(34rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<><Button design="Negative" icon="decline" disabled={busy || !ok} onClick={() => onConfirm(grund)}>Verbindlich kündigen</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <Attributes narrow>
          <Attribute label="Kündigungsdatum" strong>{dat(info.heute)}</Attribute>
          {k.art === 'MITGLIEDSCHAFT'
            ? <Attribute label="Mitgliedschaft endet" strong>{dat(info.mitgliedschaft)}</Attribute>
            : <Attribute label={`${k.v.artname || k.v.art}${!k.v.eigen ? ` (${k.v.person})` : ''} endet`} strong>{dat(k.v.endeBei)}</Attribute>}
        </Attributes>
        {k.art === 'MITGLIEDSCHAFT' && laufende.length > 0 && (
          <div>
            <Label showColon>Damit enden auch</Label>
            {laufende.map((v) => <Text key={v.vertragnr} style={{ display: 'block' }}>{v.artname || v.art} zum {dat(v.art === '90' && info.jugend < info.mitgliedschaft ? info.jugend : info.mitgliedschaft)}</Text>)}
          </div>
        )}
        <Text className="portal-muted portal-small">Nach der Kündigung wird die Kündigungsbestätigung angezeigt, in der Mitgliederakte abgelegt und per E-Mail an dich gesendet; der Vorstand erhält eine Kopie.</Text>
        <div>
          <Label showColon>Grund (optional, hilft dem Verein)</Label>
          <TextArea rows={3} value={grund} maxlength={500} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
        </div>
        <CheckBox text="Ich bestätige die Kündigung verbindlich." checked={ok} onChange={(e) => setOk(e.target.checked)} />
      </div>
    </Dialog>,
    document.body,
  );
}
