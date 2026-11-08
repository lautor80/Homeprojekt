import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, CheckBox, Dialog, Label, MessageStrip, ObjectStatus, Option, Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { CheckField, FormGrid, TextField } from '@core/components/FormFields';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { useSperre, SperrHinweis } from '@core/sperre';
import { TCO, dat, eur } from '../util';
import type { Person, Vertrag } from './typen';

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
  bank: { zahlungsart_txt: string; zahlungsweise_txt: string; iban: string; bic: string; bank: string; kontoinhaber: string; zahler: string | null; zahltSelbst: boolean; lastschrift: boolean; mandatsref: string };
  familie: Person[]; vertraege: (Vertrag & { kuendbar: boolean })[]; kuendigungsTermine: string[]; gekuendigt: boolean;
}
type Kontakt = { strasse: string; plz: string; ort: string; telefon: string; mobil: string; email: string; bildrechte: boolean };

export function MeineMitgliedschaft() {
  const [d, setD] = useState<Meine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kein, setKein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<'kontakt' | 'bank' | null>(null);
  const [kuend, setKuend] = useState<{ art: 'MITGLIEDSCHAFT' } | { art: 'VERTRAG'; v: Vertrag } | null>(null);
  const sperre = useSperre('MITGLIED', d?.mitglied.adrnr ?? null, !!dlg || !!kuend, { bezeichnung: 'Meine Mitgliedschaft' });

  const laden = () => api.get<Meine>(MG).then(setD).catch((e) => { const x = e as { status?: number; message: string }; if (x.status === 403) setKein(x.message); else setError(x.message); });
  useEffect(() => { laden(); }, []);

  async function aktion(fn: () => Promise<{ text: string }>) {
    setBusy(true); setError(null);
    try { const r = await fn(); toast(r.text, 7000); setDlg(null); setKuend(null); await laden(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }

  if (kein) return <AppPage title="Meine Mitgliedschaft"><MessageStrip design="Information" hideCloseButton>{kein}</MessageStrip></AppPage>;
  if (!d) return <AppPage title="Meine Mitgliedschaft">{error ? <MessageStrip design="Negative">{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem' }} />}</AppPage>;
  const m = d.mitglied;
  const eigene = d.vertraege.filter((v) => v.eigen);
  const fremde = d.vertraege.filter((v) => !v.eigen);

  return (
    <AppPage title="Meine Mitgliedschaft" subtitle="Eigene Daten sehen und pflegen">
      {error && !dlg && !kuend && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <SperrHinweis s={sperre} />
      <ObjectHeader title={`${m.vorname} ${m.nachname}`} subtitle={`Mitgliedsnummer ${m.mitglnrn || m.adrnr}`}
                    status={m.austritt ? <ObjectStatus state="Critical" inverted>Austritt zum {dat(m.austritt)}</ObjectStatus> : <ObjectStatus state="Positive" inverted>aktives Mitglied</ObjectStatus>}
                    actions={<>
                      {!d.gekuendigt && <Button design="Negative" icon="decline" onClick={() => { setError(null); setKuend({ art: 'MITGLIEDSCHAFT' }); }}>Mitgliedschaft kündigen</Button>}
                    </>}>
        <Attributes>
          <Attribute label="Eintritt">{dat(m.eintritt)}</Attribute>
          <Attribute label="Geburtsdatum">{dat(m.geburtsdatum)}</Attribute>
          {d.trainer && <Attribute label="Funktion">Trainer im Jugendtraining</Attribute>}
          <Attribute label="Bevorzugter Versandweg">{d.kanal === 'W' ? 'WhatsApp' : d.kanal === 'E' ? 'E-Mail' : 'E-Mail/Post'}</Attribute>
        </Attributes>
      </ObjectHeader>

      <Section title="Kontaktdaten" actions={<Button icon="edit" onClick={() => { setError(null); setDlg('kontakt'); }}>Ändern</Button>}>
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

      <Section title="Verträge" count={d.vertraege.length}>
        <Vertragsliste vertraege={eigene} onKuendigen={(v) => { setError(null); setKuend({ art: 'VERTRAG', v }); }} />
        {fremde.length > 0 && <>
          <Label showColon style={{ marginTop: '0.75rem', display: 'block' }}>Über mich bezahlte Verträge</Label>
          <Vertragsliste vertraege={fremde} onKuendigen={(v) => { setError(null); setKuend({ art: 'VERTRAG', v }); }} />
        </>}
        <Text className="portal-muted portal-small">Kündigungen sind jeweils zum Jahresende möglich; der Vorstand wird automatisch informiert.</Text>
      </Section>

      {d.familie.length > 0 && (
        <Section title="Familie" count={d.familie.length}>
          <Attributes>
            {d.familie.map((p) => <Attribute key={p.adrnr} label={p.rolle}>{p.name}{p.austritt ? ` (Austritt ${dat(p.austritt)})` : ''}</Attribute>)}
          </Attributes>
        </Section>
      )}

      {dlg === 'kontakt' && <KontaktDialog start={m} busy={busy} error={error} onClose={() => setDlg(null)} onSave={(k) => aktion(() => api.put(`${MG}/kontakt`, k))} />}
      {dlg === 'bank' && <BankDialog busy={busy} error={error} onClose={() => setDlg(null)} onSave={(b) => aktion(() => api.put(`${MG}/bank`, b))} />}
      {kuend && <KuendigungDialog k={kuend} termine={d.kuendigungsTermine} busy={busy} error={error} onClose={() => setKuend(null)}
                                  onConfirm={(zum, grund) => aktion(() => api.post(`${MG}/kuendigung`, {
                                    art: kuend.art, zum, grund: grund || null, bestaetigung: true,
                                    ...(kuend.art === 'VERTRAG' ? { adrnr: kuend.v.adrnr, vertragnr: kuend.v.vertragnr } : {}),
                                  }))} />}
    </AppPage>
  );
}

function Vertragsliste({ vertraege, onKuendigen }: { vertraege: (Vertrag & { kuendbar: boolean })[]; onKuendigen: (v: Vertrag) => void }) {
  if (!vertraege.length) return <Text className="portal-muted">Keine Verträge.</Text>;
  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      {vertraege.map((v) => (
        <div key={`${v.adrnr}-${v.vertragnr}`} className="portal-row" style={{ justifyContent: 'space-between', padding: '0.5rem 0.75rem', borderRadius: 'var(--portal-radius, 0.75rem)', background: 'var(--sapList_HeaderBackground, #f5f6f7)' }}>
          <div style={{ lineHeight: 1.3 }}>
            <Text>{v.artname || v.art}{!v.eigen ? ` · ${v.person}` : ''}</Text><br />
            <Label>{eur(v.betrag)}{v.sollstellung ? ` ${v.sollstellung}` : ''} · ab {dat(v.vertragbegin)}{v.vertragende ? ` bis ${dat(v.vertragende)}` : ' · unbefristet'}{v.zahler && v.zahler !== 'wie Mitglied' ? ` · Zahler: ${v.zahler}` : ''}</Label>
          </div>
          <div className="portal-row">
            <ObjectStatus state={v.laeuft ? 'Positive' : 'None'}>{v.laeuft ? (v.vertragende ? 'gekündigt' : 'läuft') : 'beendet'}</ObjectStatus>
            {v.laeuft && !v.vertragende && <Button design="Transparent" icon="decline" onClick={() => onKuendigen(v)}>Kündigen</Button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function KontaktDialog({ start, busy, error, onClose, onSave }: { start: Kontakt; busy: boolean; error: string | null; onClose: () => void; onSave: (k: Kontakt) => void }) {
  const [k, setK] = useState<Kontakt>({ strasse: start.strasse, plz: start.plz, ort: start.ort, telefon: start.telefon, mobil: start.mobil, email: start.email, bildrechte: start.bildrechte });
  const set = (f: keyof Kontakt) => (v: string) => setK({ ...k, [f]: v });
  return createPortal(
    <Dialog open headerText="Kontaktdaten ändern" style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<><Button design="Emphasized" loading={busy} onClick={() => onSave(k)}>Sichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
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
            footer={<Bar endContent={<><Button design="Emphasized" loading={busy} disabled={!b.iban.trim() || !ok} onClick={() => onSave(b)}>Sichern</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
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

function KuendigungDialog({ k, termine, busy, error, onClose, onConfirm }: {
  k: { art: 'MITGLIEDSCHAFT' } | { art: 'VERTRAG'; v: Vertrag }; termine: string[]; busy: boolean; error: string | null; onClose: () => void; onConfirm: (zum: string, grund: string) => void;
}) {
  const [zum, setZum] = useState(termine[0]);
  const [grund, setGrund] = useState('');
  const [ok, setOk] = useState(false);
  const was = k.art === 'MITGLIEDSCHAFT' ? 'die Mitgliedschaft' : `den Vertrag „${k.v.artname || k.v.art}“${!k.v.eigen ? ` von ${k.v.person}` : ''}`;
  return createPortal(
    <Dialog open headerText={k.art === 'MITGLIEDSCHAFT' ? 'Mitgliedschaft kündigen' : 'Vertrag kündigen'} style={{ width: 'min(32rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<><Button design="Negative" icon="decline" loading={busy} disabled={!ok} onClick={() => onConfirm(zum, grund)}>Verbindlich kündigen</Button><Button onClick={onClose}>Abbrechen</Button></>} />}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{error}</MessageStrip>}
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <Text>Sie kündigen {was} zum gewählten Jahresende. {k.art === 'MITGLIEDSCHAFT' ? 'Alle eigenen Verträge enden zu diesem Termin; das SEPA-Mandat wird befristet.' : ''}</Text>
        <div>
          <Label showColon required>Kündigung zum</Label>
          <Select style={{ width: '100%' }} onChange={(e) => setZum((e.detail.selectedOption as HTMLElement).dataset.z!)}>
            {termine.map((t) => <Option key={t} data-z={t} selected={t === zum}>{dat(t)}</Option>)}
          </Select>
        </div>
        <div>
          <Label showColon>Grund (optional, hilft dem Verein)</Label>
          <TextArea rows={3} value={grund} maxlength={500} onInput={(e) => setGrund(e.target.value)} style={{ width: '100%' }} />
        </div>
        <CheckBox text="Ich bestätige die Kündigung. Sie wird dem Vorstand übermittelt und im Mitgliederstamm hinterlegt." checked={ok} onChange={(e) => setOk(e.target.checked)} />
      </div>
    </Dialog>,
    document.body,
  );
}
