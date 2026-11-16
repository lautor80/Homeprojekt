import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, FlexBox, Input, Label, Link, List, ListItemStandard, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, ProgressIndicator,
  Select, Text, TextArea,
} from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition, AnalyticalTableCellInstance as Cell } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { FieldBox, FormGrid } from '@core/components/FormFields';
import { MasterDetail } from '@core/components/MasterDetail';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { download, PdfDialog } from '@core/components/PdfDialog';
import { ResponsiveTable } from '@core/components/ResponsiveTable';
import { Empty, Section } from '@core/components/Section';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dateiLesen, TCO } from '../util';

/**
 * App „Rundschreiben“: E-Mails an alle Mitglieder oder an Mitgliedergruppen. Links die Rundschreiben (Entwürfe zuerst),
 * rechts der Entwurf (Empfänger wählen, verfassen, Anhänge, Empfänger prüfen mit Vorschau, Testmail, Senden) bzw. bei
 * gesendeten Rundschreiben das Versandprotokoll je Empfänger mit Fortschritt.
 */
const RS = `${TCO}/rundschreiben`;

type Status = 'ENTWURF' | 'VERSAND' | 'ANGEHALTEN' | 'FERTIG';
interface Zaehler { gesamt: number; offen: number; gesendet: number; fehler: number; ohne_mail: number }
interface Auswahl { alle: boolean; gruppen: number[]; alter: '' | 'ERWACHSENE' | 'JUGEND'; arten: string[]; dazu: string[]; ohne: string[] }
interface ListenZeile { id: number; betreff: string; status: Status; erstellt_von: string | null; geaendert_am: string; gesendet_am: string | null; gesendet_von: string | null; zaehler: Zaehler }
interface Anhang { id: number; dateiname: string; mime: string; groesse: number }
interface Kopf {
  id: number; betreff: string; text: string; antwort_an: string | null; auswahl: Auswahl; status: Status; hinweis: string | null; kopie_von: number | null;
  erstellt_am: string; erstellt_von: string | null; geaendert_am: string; geaendert_von: string | null; gesendet_am: string | null; gesendet_von: string | null;
  absender: string | null; fertig_am: string | null; paperless_id: number | null; anhaenge: Anhang[]; zaehler: Zaehler;
}
interface Werte {
  gruppen: { id: number; name: string; pfad: string; ebene: number; gesamt: number }[]; arten: { art: string; text: string; anzahl: number }[];
  personen: { adrnr: string; name: string; mitglied: boolean }[]; platzhalter: Record<string, string>; anhang_max: number; anhang_anzahl: number;
}
interface Pruefung {
  empfaenger: { email: string; namen: string; anrede: string; personen: number; weg: string; weg_text: string; unzustellbar: string | null }[];
  ohne_mail: { adrnr: string; name: string; grund: string }[];
  anzahl: { personen: number; mails: number; ohne_mail: number; dubletten: number; ausgeschlossen: number; unzustellbar: number };
  beispiel: { an: string; namen: string; betreff: string; text: string } | null; mail: boolean;
}
interface ProtokollZeile { id: number; email: string | null; namen: string; personen: number; weg: string; status: string; fehler: string | null; versuche: number; gesendet_am: string | null }

const STATUS: Record<Status, { text: string; state: 'None' | 'Information' | 'Positive' | 'Critical' }> = {
  ENTWURF: { text: 'Entwurf', state: 'None' }, VERSAND: { text: 'Versand läuft', state: 'Information' },
  ANGEHALTEN: { text: 'Versand angehalten', state: 'Critical' }, FERTIG: { text: 'Gesendet', state: 'Positive' },
};
const ZEILE: Record<string, { text: string; state: 'None' | 'Information' | 'Positive' | 'Critical' | 'Negative' }> = {
  OFFEN: { text: 'offen', state: 'None' }, SENDET: { text: 'wird gesendet', state: 'Information' }, GESENDET: { text: 'gesendet', state: 'Positive' },
  FEHLER: { text: 'Fehler', state: 'Negative' }, OHNE_MAIL: { text: 'ohne E-Mail-Adresse', state: 'Critical' },
};
const zeit = (ts: string | null | undefined) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const mb = (n: number) => (n < 1024 * 1024 ? `${n ? Math.max(1, Math.round(n / 1024)) : 0} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const mehrzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;
const gewaehlt = (e: { detail: { items: unknown } }) => (e.detail.items as HTMLElement[]).map((i) => i.dataset.k ?? '').filter(Boolean);

export function Rundschreiben() {
  const can = useCan();
  const darf = { edit: can('tco.rundschreiben:edit'), senden: can('tco.rundschreiben:execute') };
  const [liste, setListe] = useState<ListenZeile[] | null>(null);
  const [paperless, setPaperless] = useState(false);
  const [mail, setMail] = useState(true);
  const [id, setId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const laden = useCallback(() => api.get<{ liste: ListenZeile[]; mail: boolean; paperless: boolean }>(RS)
    .then((r) => { setListe(r.liste); setPaperless(r.paperless); setMail(r.mail); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { laden(); }, [laden]);

  async function neu() {
    setError(null);
    try {
      const r = await api.post<{ id: number }>(RS);
      await laden();
      setId(r.id);
    } catch (e) { setError((e as Error).message); }
  }

  const sel = liste?.find((z) => z.id === id) ?? null;
  return (
    <AppPage title="Rundschreiben" subtitle="Vereinsinformation per E-Mail an alle Mitglieder oder an Mitgliedergruppen – jede Person erhält ihre eigene E-Mail"
             actions={darf.edit ? <Button icon="add" design="Emphasized" onClick={neu}>Neues Rundschreiben</Button> : undefined}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {!mail && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.5rem' }}>
          Der Mailversand ist nicht eingerichtet (Administration → Schnittstellen → E-Mail) – Entwürfe lassen sich vorbereiten, aber nicht senden.
        </MessageStrip>
      )}
      <MasterDetail
        masterWidth="22rem"
        emptyTitle="Kein Rundschreiben ausgewählt"
        emptyText={darf.edit ? 'Links ein Rundschreiben wählen oder über „Neues Rundschreiben“ einen Entwurf anlegen.' : 'Links ein Rundschreiben wählen.'}
        onBack={() => setId(null)}
        master={
          <List onItemClick={(e) => setId(Number((e.detail.item as HTMLElement).dataset.id))} noDataText="Noch keine Rundschreiben">
            {liste?.map((z) => (
              <ListItemStandard key={z.id} data-id={z.id} type="Active" selected={z.id === id}
                                icon={z.status === 'ENTWURF' ? 'edit' : z.status === 'FERTIG' ? 'email' : 'paper-plane'}
                                description={z.status === 'ENTWURF' ? `Entwurf · geändert ${zeit(z.geaendert_am)}` : `${zeit(z.gesendet_am)} · ${z.gesendet_von ?? ''}`}
                                additionalText={z.status === 'ENTWURF' ? '' : z.status === 'FERTIG' ? (z.zaehler.fehler ? mehrzahl(z.zaehler.fehler, 'Fehler', 'Fehler') : `${z.zaehler.gesendet} gesendet`) : STATUS[z.status].text}
                                additionalTextState={z.status === 'ENTWURF' ? 'None' : z.zaehler.fehler || z.status === 'ANGEHALTEN' ? 'Critical' : z.status === 'FERTIG' ? 'Positive' : 'Information'}>
                {z.betreff || '(ohne Betreff)'}
              </ListItemStandard>
            ))}
          </List>
        }
        detail={sel ? (
          sel.status === 'ENTWURF'
            ? <Entwurf key={sel.id} id={sel.id} darf={darf} onGeaendert={laden} onWeg={() => { setId(null); laden(); }} onKopie={(n) => { laden(); setId(n); }} />
            : <Protokoll key={sel.id} id={sel.id} darf={darf} paperless={paperless} onGeaendert={laden} onKopie={(n) => { laden(); setId(n); }} />
        ) : null}
      />
    </AppPage>
  );
}

// ---------------------------------------------------------------- Entwurf
function Entwurf({ id, darf, onGeaendert, onWeg, onKopie }: {
  id: number; darf: { edit: boolean; senden: boolean }; onGeaendert: () => void; onWeg: () => void; onKopie: (id: number) => void;
}) {
  const [k, setK] = useState<Kopf | null>(null);
  const [w, setW] = useState<Werte | null>(null);
  const [geaendert, setGeaendert] = useState(false);
  const [p, setP] = useState<Pruefung | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frage, setFrage] = useState<'senden' | 'loeschen' | null>(null);
  const datei = useRef<HTMLInputElement>(null);
  const edit = darf.edit;

  useEffect(() => {
    api.get<Kopf>(`${RS}/${id}`).then(setK).catch((e) => setError((e as Error).message));
    if (edit) api.get<Werte>(`${RS}/auswahl`).then(setW).catch((e) => setError((e as Error).message));
  }, [id, edit]);

  const setze = (x: Partial<Kopf>) => { if (k) { setK({ ...k, ...x }); setGeaendert(true); setP(null); } };
  const wahl = (x: Partial<Auswahl>) => k && setze({ auswahl: { ...k.auswahl, ...x } });

  /** Entwurf sichern (nur wenn geändert) – vor jeder Aktion, die den gesicherten Stand braucht */
  async function sichern(still = false): Promise<boolean> {
    if (!k) return false;
    if (!edit || !geaendert) return true;
    try {
      await api.put(`${RS}/${id}`, { betreff: k.betreff, text: k.text, antwort_an: k.antwort_an, auswahl: k.auswahl });
      setGeaendert(false);
      onGeaendert();
      if (!still) toast('Entwurf gesichert');
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }
  const aktion = async (f: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { if (await sichern(true)) await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const pruefen = (fuer?: string) => aktion(async () => {
    setP(await api.get<Pruefung>(`${RS}/${id}/empfaenger${fuer ? `?fuer=${encodeURIComponent(fuer)}` : ''}`));
  });
  const testmail = () => aktion(async () => { toast((await api.post<{ text: string }>(`${RS}/${id}/test`)).text, 6000); });
  const kopieren = () => aktion(async () => { onKopie((await api.post<{ id: number }>(`${RS}/${id}/kopieren`)).id); });
  const senden = () => aktion(async () => {
    if (!p) return;
    toast((await api.post<{ text: string }>(`${RS}/${id}/senden`, { mails: p.anzahl.mails })).text, 6000);
    onGeaendert();
  });
  const loeschen = () => aktion(async () => { await api.del(`${RS}/${id}`); onWeg(); });

  async function hochladen(files: FileList | null) {
    if (!files?.length || !k) return;
    setBusy(true); setError(null);
    try {
      let anhaenge = k.anhaenge;
      for (const f of Array.from(files)) {
        anhaenge = (await api.post<{ anhaenge: Anhang[] }>(`${RS}/${id}/anhaenge`, { dateiname: f.name, data: await dateiLesen(f) })).anhaenge;
      }
      setK((alt) => (alt ? { ...alt, anhaenge } : alt));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); if (datei.current) datei.current.value = ''; }
  }
  async function anhangWeg(a: Anhang) {
    setError(null);
    try {
      const r = await api.del<{ anhaenge: Anhang[] }>(`${RS}/${id}/anhaenge/${a.id}`);
      setK((alt) => (alt ? { ...alt, anhaenge: r.anhaenge } : alt));
    } catch (e) { setError((e as Error).message); }
  }

  const spalten: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Empfänger', accessor: 'namen', minWidth: 180 },
    { Header: 'E-Mail-Adresse', accessor: 'email', minWidth: 200 },
    { Header: 'Anrede', accessor: 'anrede', minWidth: 160 },
    {
      Header: 'Hinweis', id: 'hinweis', minWidth: 180,
      accessor: (r: Record<string, unknown>) => {
        const e = r as unknown as Pruefung['empfaenger'][number];
        return [e.unzustellbar ?? '', e.personen > 1 ? `${e.personen} Personen, eine E-Mail` : '', e.weg !== 'EIGEN' ? e.weg_text : ''].filter(Boolean).join(' · ');
      },
      Cell: ({ row, value }: Cell) => ((row.original as Pruefung['empfaenger'][number]).unzustellbar
        ? <ObjectStatus state="Negative"><span title={value}>{value}</span></ObjectStatus> : <span title={value}>{value}</span>),
    },
    {
      Header: '', id: 'vorschau', width: 110, disableSortBy: true,
      Cell: ({ row }: Cell) => <Link onClick={() => pruefen((row.original as Pruefung['empfaenger'][number]).email)}>Vorschau</Link>,
    },
  ], [k, geaendert]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!k) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  const groesse = k.anhaenge.reduce((s, a) => s + a.groesse, 0);
  const nachGruppen = !k.auswahl.alle;

  return (
    <>
      <ObjectHeader title={k.betreff || 'Neues Rundschreiben'} icon="edit"
                    subtitle={`Entwurf · angelegt von ${k.erstellt_von ?? '–'}${k.kopie_von ? ` · Vorlage: Rundschreiben ${k.kopie_von}` : ''}`}
                    status={<><ObjectStatus state="None">Entwurf</ObjectStatus>{geaendert && <ObjectStatus state="Critical">nicht gesichert</ObjectStatus>}</>}
                    actions={<ChangeHistoryButton objectType="RUNDSCHREIBEN" objectKey={String(id)} />} />
      {edit && (
        <FlexBox wrap="Wrap" style={{ gap: '0.5rem', margin: '0.5rem 0' }}>
          <Button design="Emphasized" icon="save" disabled={busy || !geaendert} onClick={() => sichern()}>Sichern</Button>
          <Button icon="email" disabled={busy} onClick={testmail} tooltip="Sendet das Rundschreiben mit den Anhängen nur an Ihre eigene E-Mail-Adresse">Testmail an mich</Button>
          <Button icon="copy" design="Transparent" disabled={busy} onClick={kopieren}>Kopieren</Button>
          <Button icon="delete" design="Transparent" disabled={busy} onClick={() => setFrage('loeschen')}>Entwurf löschen</Button>
        </FlexBox>
      )}
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ margin: '0.5rem 0' }}>{error}</MessageStrip>}

      <Section title="1. Empfänger wählen">
        <FormGrid>
          <FieldBox label="An">
            <Select disabled={!edit} onChange={(e) => wahl({ alle: (e.detail.selectedOption as HTMLElement).dataset.k === 'ALLE' })}>
              <Option data-k="ALLE" selected={k.auswahl.alle}>Alle aktiven Mitglieder</Option>
              <Option data-k="GRUPPEN" selected={!k.auswahl.alle}>Mitglieder ausgewählter Gruppen</Option>
            </Select>
          </FieldBox>
          {nachGruppen && (
            <FieldBox label="Mitgliedergruppen (Untergruppen eingeschlossen)" required>
              <MultiComboBox disabled={!edit} noTypeahead placeholder="Gruppen wählen" onSelectionChange={(e) => wahl({ gruppen: gewaehlt(e).map(Number) })}>
                {w?.gruppen.map((g) => <MultiComboBoxItem key={g.id} data-k={g.id} text={g.pfad} additionalText={`${g.gesamt}`} selected={k.auswahl.gruppen.includes(g.id)} />)}
              </MultiComboBox>
            </FieldBox>
          )}
          <FieldBox label="Altersgruppe">
            <Select disabled={!edit} onChange={(e) => wahl({ alter: ((e.detail.selectedOption as HTMLElement).dataset.k ?? '') as Auswahl['alter'] })}>
              <Option data-k="" selected={k.auswahl.alter === ''}>Alle</Option>
              <Option data-k="ERWACHSENE" selected={k.auswahl.alter === 'ERWACHSENE'}>Erwachsene (ab 18 Jahren)</Option>
              <Option data-k="JUGEND" selected={k.auswahl.alter === 'JUGEND'}>Kinder und Jugendliche (unter 18)</Option>
            </Select>
          </FieldBox>
          <FieldBox label="Beitragsart (leer = alle)">
            <MultiComboBox disabled={!edit} noTypeahead placeholder="Alle Beitragsarten" onSelectionChange={(e) => wahl({ arten: gewaehlt(e) })}>
              {w?.arten.map((a) => <MultiComboBoxItem key={a.art} data-k={a.art} text={a.text} additionalText={`${a.anzahl}`} selected={k.auswahl.arten.includes(a.art)} />)}
            </MultiComboBox>
          </FieldBox>
          <FieldBox label="Zusätzlich einzelne Personen">
            <MultiComboBox disabled={!edit} placeholder="Name suchen" onSelectionChange={(e) => wahl({ dazu: gewaehlt(e) })}>
              {w?.personen.map((x) => <MultiComboBoxItem key={x.adrnr} data-k={x.adrnr} text={x.name} additionalText={x.mitglied ? '' : 'Zahler/Elternteil'} selected={k.auswahl.dazu.includes(x.adrnr)} />)}
            </MultiComboBox>
          </FieldBox>
          <FieldBox label="Diese Personen ausschließen">
            <MultiComboBox disabled={!edit} placeholder="Name suchen" onSelectionChange={(e) => wahl({ ohne: gewaehlt(e) })}>
              {w?.personen.map((x) => <MultiComboBoxItem key={x.adrnr} data-k={x.adrnr} text={x.name} selected={k.auswahl.ohne.includes(x.adrnr)} />)}
            </MultiComboBox>
          </FieldBox>
        </FormGrid>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Empfänger sind nur aktive Mitglieder – Ausgetretene und Schnupper-Kontakte nie. Bei Minderjährigen geht die E-Mail an die Eltern
          (Zahler bzw. Kontoinhaber). Teilen sich mehrere Personen eine Adresse, kommt dort nur eine E-Mail an.
        </Text>
      </Section>

      <Section title="2. Verfassen">
        <FormGrid>
          <FieldBox label="Betreff" required>
            <Input style={{ width: '100%' }} value={k.betreff} readonly={!edit} maxlength={200} onInput={(e) => setze({ betreff: e.target.value })} />
          </FieldBox>
          <FieldBox label="Antworten gehen an (leer = an mich als Absender)">
            <Input style={{ width: '100%' }} type="Email" value={k.antwort_an ?? ''} readonly={!edit} placeholder="z. B. vorstand@…" onInput={(e) => setze({ antwort_an: e.target.value || null })} />
          </FieldBox>
          <FieldBox label="Text" required wide>
            <TextArea rows={14} growing growingMaxRows={30} value={k.text} readonly={!edit} onInput={(e) => setze({ text: e.target.value })} />
          </FieldBox>
        </FormGrid>
        {edit && w && (
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.25rem 0.5rem', marginTop: '0.5rem' }}>
            <Label>Platzhalter einfügen:</Label>
            {Object.entries(w.platzhalter).map(([name, text]) => (
              <Button key={name} design="Transparent" tooltip={text} onClick={() => setze({ text: `${k.text}{${name}}` })}>{`{${name}}`}</Button>
            ))}
          </FlexBox>
        )}
      </Section>

      <Section title="3. Anhänge" count={k.anhaenge.length}
               actions={edit ? <Button icon="attachment" disabled={busy} onClick={() => datei.current?.click()}>Datei anhängen</Button> : undefined}>
        <input ref={datei} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" style={{ display: 'none' }} onChange={(e) => hochladen(e.target.files)} />
        {k.anhaenge.length === 0 ? <Empty>Keine Anhänge</Empty> : k.anhaenge.map((a) => (
          <FlexBox key={a.id} alignItems="Center" style={{ gap: '0.5rem' }}>
            <Link onClick={() => download(`${RS}/${id}/anhaenge/${a.id}`, a.dateiname).catch((e) => setError((e as Error).message))}>{a.dateiname}</Link>
            <Text className="portal-muted portal-small">{mb(a.groesse)}</Text>
            {edit && <Button icon="decline" design="Transparent" tooltip="Anhang entfernen" onClick={() => anhangWeg(a)} />}
          </FlexBox>
        ))}
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          PDF und Bilder (JPG, PNG), höchstens {w?.anhang_anzahl ?? 5} Dateien und zusammen {mb(w?.anhang_max ?? 5 * 1024 * 1024)} – jetzt {mb(groesse)}. Große Dateien besser verlinken.
        </Text>
      </Section>

      <Section title="4. Empfänger prüfen und senden"
               actions={<Button icon="group" disabled={busy} onClick={() => pruefen()}>{p ? 'Neu prüfen' : 'Empfänger prüfen'}</Button>}>
        {!p && <Empty>Vor dem Senden die Empfängerliste prüfen: Anzahl, Personen ohne E-Mail-Adresse, gemeinsame Adressen und die Vorschau mit echten Werten.</Empty>}
        {p && (
          <>
            <MessageStrip design={p.anzahl.mails ? 'Information' : 'Critical'} hideCloseButton style={{ marginBottom: '0.75rem' }}>
              <b>{mehrzahl(p.anzahl.mails, 'E-Mail', 'E-Mails')}</b> für {mehrzahl(p.anzahl.personen - p.anzahl.ohne_mail, 'Person', 'Personen')}
              {' · '}{mehrzahl(p.anzahl.ohne_mail, 'Person', 'Personen')} ohne E-Mail-Adresse
              {p.anzahl.dubletten ? ` · ${mehrzahl(p.anzahl.dubletten, 'E-Mail', 'E-Mails')} weniger durch gemeinsame Adressen` : ''}
              {p.anzahl.ausgeschlossen ? ` · ${p.anzahl.ausgeschlossen} ausgeschlossen` : ''}
            </MessageStrip>
            <ResponsiveTable columns={spalten} data={p.empfaenger} visibleRows={Math.min(Math.max(p.empfaenger.length, 1), 12)} filterable sortable
                             noDataText="Kein Empfänger mit E-Mail-Adresse" />
            {p.ohne_mail.length > 0 && (
              <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>
                Ohne E-Mail-Adresse – diese Personen erreicht das Rundschreiben nicht (nach dem Versand als Liste für Brief oder Aushang):
                {' '}{p.ohne_mail.map((o) => `${o.name}${o.grund === 'keine E-Mail-Adresse' ? '' : ` (${o.grund})`}`).join(', ')}
              </MessageStrip>
            )}
            {p.anzahl.unzustellbar > 0 && (
              <MessageStrip design="Critical" hideCloseButton style={{ marginTop: '0.75rem' }}>
                {mehrzahl(p.anzahl.unzustellbar, 'Adresse ist', 'Adressen sind')} im Mitgliederstamm als unzustellbar vermerkt – dorthin geht keine E-Mail, sie
                {' '}erscheinen nach dem Versand unter „Fehler“. Adresse im Mitgliederstamm berichtigen oder den Vermerk dort aufheben.
              </MessageStrip>
            )}
            {p.beispiel && (
              <div style={{ marginTop: '0.75rem' }}>
                <Label>Vorschau für {p.beispiel.namen} ({p.beispiel.an})</Label>
                <div className="portal-section" style={{ padding: '0.75rem 1rem', marginTop: '0.25rem' }}>
                  <Text style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>{p.beispiel.betreff || '(ohne Betreff)'}</Text>
                  <Text style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{p.beispiel.text}</Text>
                </div>
              </div>
            )}
            {darf.senden && (
              <FlexBox justifyContent="End" style={{ marginTop: '0.75rem' }}>
                <Button design="Emphasized" icon="paper-plane" disabled={busy || !p.anzahl.mails || !p.mail || !k.betreff.trim() || !k.text.trim()} onClick={() => setFrage('senden')}>
                  {`An ${mehrzahl(p.anzahl.mails, 'Adresse', 'Adressen')} senden`}
                </Button>
              </FlexBox>
            )}
            {!darf.senden && <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>Senden darf, wer die Berechtigung „Rundschreiben senden“ hat.</Text>}
          </>
        )}
      </Section>

      <ConfirmDialog open={frage === 'senden'} title="Rundschreiben jetzt senden?" confirmText={`An ${mehrzahl(p?.anzahl.mails ?? 0, 'Adresse', 'Adressen')} senden`}
                     text={`„${k.betreff}“ geht an ${mehrzahl(p?.anzahl.mails ?? 0, 'E-Mail-Adresse', 'E-Mail-Adressen')} – jede Person erhält ihre eigene E-Mail.`
                       + `${p?.anzahl.ohne_mail ? ` ${mehrzahl(p.anzahl.ohne_mail, 'Person hat', 'Personen haben')} keine E-Mail-Adresse und wird bzw. werden nicht erreicht.` : ''}`
                       + '\n\nDer Versand läuft im Hintergrund und lässt sich nicht zurückholen. Danach ist das Rundschreiben nicht mehr änderbar.'}
                     onCancel={() => setFrage(null)} onConfirm={() => { setFrage(null); senden(); }} />
      <ConfirmDialog open={frage === 'loeschen'} danger title="Entwurf löschen?" confirmText="Löschen" text="Der Entwurf wird mit seinen Anhängen gelöscht."
                     onCancel={() => setFrage(null)} onConfirm={() => { setFrage(null); loeschen(); }} />
    </>
  );
}

// ---------------------------------------------------------------- Protokoll eines gesendeten Rundschreibens
function Protokoll({ id, darf, paperless, onGeaendert, onKopie }: {
  id: number; darf: { edit: boolean; senden: boolean }; paperless: boolean; onGeaendert: () => void; onKopie: (id: number) => void;
}) {
  const [k, setK] = useState<Kopf | null>(null);
  const [zeilen, setZeilen] = useState<ProtokollZeile[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdf, setPdf] = useState(false);
  const [erneut, setErneut] = useState(false);

  const laden = useCallback(async () => {
    try {
      const [kopf, p] = await Promise.all([api.get<Kopf>(`${RS}/${id}`), api.get<{ zeilen: ProtokollZeile[] }>(`${RS}/${id}/protokoll`)]);
      setK(kopf); setZeilen(p.zeilen);
      return kopf.status;
    } catch (e) { setError((e as Error).message); return null; }
  }, [id]);
  useEffect(() => { laden(); }, [laden]);
  // Fortschritt: solange der Versand läuft, alle zwei Sekunden nachsehen
  const laeuft = k?.status === 'VERSAND';
  useEffect(() => {
    if (!laeuft) return;
    const t = setInterval(async () => { if ((await laden()) !== 'VERSAND') onGeaendert(); }, 2000);
    return () => clearInterval(t);
  }, [laeuft, laden, onGeaendert]);

  const aktion = async (pfad: string, body?: unknown) => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await api.post<{ text: string; warnungen?: string[]; id?: number }>(`${RS}/${id}/${pfad}`, body);
      if (pfad === 'kopieren' && r.id) { onKopie(r.id); return; }
      toast(r.text, 6000);
      if (r.warnungen?.length) setInfo(r.warnungen.join(' · '));
      await laden();
      onGeaendert();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const spalten: AnalyticalTableColumnDefinition[] = useMemo(() => [
    { Header: 'Empfänger', accessor: 'namen', minWidth: 180 },
    { Header: 'E-Mail-Adresse', accessor: 'email', minWidth: 200, Cell: ({ value }: Cell) => value || '–' },
    { Header: 'Status', accessor: 'status', width: 170, Cell: ({ value }: Cell) => <ObjectStatus state={ZEILE[value]?.state ?? 'None'}>{ZEILE[value]?.text ?? value}</ObjectStatus> },
    { Header: 'Grund', accessor: 'fehler', minWidth: 180, Cell: ({ value }: Cell) => <span title={value ?? ''}>{value ?? ''}</span> },
    { Header: 'Gesendet', accessor: 'gesendet_am', width: 150, Cell: ({ value }: Cell) => zeit(value) },
    { Header: 'Versuche', accessor: 'versuche', width: 100, hAlign: 'End' },
  ], []);

  if (!k) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  const z = k.zaehler;
  const erledigt = z.gesendet + z.fehler;
  const nichtErreicht = z.fehler + z.ohne_mail;
  const ruht = k.status === 'FERTIG' || k.status === 'ANGEHALTEN';
  const sicht = filter ? zeilen.filter((x) => (filter === 'OFFEN' ? x.status === 'OFFEN' || x.status === 'SENDET' : x.status === filter)) : zeilen;

  return (
    <>
      <ObjectHeader title={k.betreff} icon="email" subtitle={`Rundschreiben ${k.id} · gesendet von ${k.gesendet_von ?? '–'}`}
                    status={<ObjectStatus state={z.fehler && k.status === 'FERTIG' ? 'Critical' : STATUS[k.status].state}>{STATUS[k.status].text}{z.fehler && k.status === 'FERTIG' ? ` – ${mehrzahl(z.fehler, 'Fehler', 'Fehler')}` : ''}</ObjectStatus>}
                    actions={<ChangeHistoryButton objectType="RUNDSCHREIBEN" objectKey={String(id)} />}>
        <Attributes>
          <Attribute label="Gesendet am">{zeit(k.gesendet_am)}</Attribute>
          <Attribute label="E-Mails gesendet" strong>{`${z.gesendet} von ${z.gesamt}`}</Attribute>
          <Attribute label="Fehler">{z.fehler ? <ObjectStatus state="Negative">{z.fehler}</ObjectStatus> : '0'}</Attribute>
          <Attribute label="Ohne E-Mail-Adresse">{z.ohne_mail ? <ObjectStatus state="Critical">{z.ohne_mail}</ObjectStatus> : '0'}</Attribute>
          <Attribute label="Absender">{k.absender ?? 'Absender der Anwendung'}</Attribute>
          <Attribute label="Antworten an">{k.antwort_an ?? k.absender ?? ''}</Attribute>
          <Attribute label="Paperless">{k.paperless_id ? `DOKID ${String(k.paperless_id).padStart(6, '0')}` : ''}</Attribute>
        </Attributes>
      </ObjectHeader>
      <FlexBox wrap="Wrap" style={{ gap: '0.5rem', margin: '0.5rem 0' }}>
        {darf.senden && k.status === 'VERSAND' && <Button icon="media-pause" disabled={busy} onClick={() => aktion('anhalten')}>Anhalten</Button>}
        {darf.senden && k.status === 'ANGEHALTEN' && <Button design="Emphasized" icon="media-play" disabled={busy} onClick={() => aktion('fortsetzen')}>Versand fortsetzen</Button>}
        {darf.senden && ruht && nichtErreicht > 0 && <Button icon="synchronize" disabled={busy} onClick={() => setErneut(true)}>Fehlgeschlagene erneut senden</Button>}
        <Button icon="pdf-attachment" onClick={() => setPdf(true)}>Ausdruck</Button>
        {nichtErreicht > 0 && (
          <Button icon="download" tooltip="Nicht per E-Mail Erreichte mit Anschrift – für Brief oder Aushang"
                  onClick={() => download(`${RS}/${id}/nicht-erreicht.csv`, `Rundschreiben_${id}_nicht_erreicht.csv`).catch((e) => setError((e as Error).message))}>Nicht erreicht (CSV)</Button>
        )}
        {darf.senden && paperless && k.status === 'FERTIG' && !k.paperless_id && <Button icon="upload-to-cloud" disabled={busy} onClick={() => aktion('paperless')}>In Paperless ablegen</Button>}
        {darf.edit && <Button icon="copy" design="Transparent" disabled={busy} onClick={() => aktion('kopieren')} tooltip="Als Vorlage für ein neues Rundschreiben kopieren">Als Vorlage</Button>}
      </FlexBox>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ margin: '0.5rem 0' }}>{error}</MessageStrip>}
      {info && <MessageStrip design="Information" onClose={() => setInfo(null)} style={{ margin: '0.5rem 0' }}>{info}</MessageStrip>}
      {k.status === 'ANGEHALTEN' && k.hinweis && <MessageStrip design="Critical" hideCloseButton style={{ margin: '0.5rem 0' }}>{k.hinweis}</MessageStrip>}
      {k.status === 'VERSAND' && (
        <Section title="Versand läuft im Hintergrund">
          <ProgressIndicator value={z.gesamt ? Math.round((erledigt / z.gesamt) * 100) : 0} displayValue={`${erledigt} von ${z.gesamt}`} valueState={z.fehler ? 'Critical' : 'Information'} />
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.25rem' }}>
            Die Seite kann geschlossen werden – der Versand läuft weiter, auch nach einem Neustart des Portals.
          </Text>
        </Section>
      )}

      <Section title="Versandprotokoll" count={sicht.length} flush
               actions={
                 <Select onChange={(e) => setFilter((e.detail.selectedOption as HTMLElement).dataset.k ?? '')}>
                   <Option data-k="" selected={filter === ''}>Alle ({zeilen.length})</Option>
                   <Option data-k="GESENDET" selected={filter === 'GESENDET'}>Gesendet ({z.gesendet})</Option>
                   <Option data-k="FEHLER" selected={filter === 'FEHLER'}>Fehler ({z.fehler})</Option>
                   <Option data-k="OHNE_MAIL" selected={filter === 'OHNE_MAIL'}>Ohne E-Mail-Adresse ({z.ohne_mail})</Option>
                   <Option data-k="OFFEN" selected={filter === 'OFFEN'}>Offen ({z.offen})</Option>
                 </Select>
               }>
        <ResponsiveTable columns={spalten} data={sicht} visibleRows={Math.min(Math.max(sicht.length, 1), 15)} filterable sortable noDataText="Keine Einträge" />
      </Section>

      <Section title="Nachricht">
        <Text style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{k.text}</Text>
        {k.anhaenge.length > 0 && (
          <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: '0.25rem 1rem', marginTop: '0.75rem' }}>
            <Label>Anhänge:</Label>
            {k.anhaenge.map((a) => <Link key={a.id} onClick={() => download(`${RS}/${id}/anhaenge/${a.id}`, a.dateiname).catch((e) => setError((e as Error).message))}>{a.dateiname}</Link>)}
          </FlexBox>
        )}
      </Section>

      <ConfirmDialog open={erneut} title="Fehlgeschlagene erneut senden?" confirmText="Erneut senden"
                     text={`${mehrzahl(nichtErreicht, 'Person wurde', 'Empfänger wurden')} nicht erreicht (${z.fehler} Fehler, ${z.ohne_mail} ohne E-Mail-Adresse). `
                       + 'Gesendet wird nur an sie – mit der Adresse, die jetzt im Mitgliederstamm steht (berichtigte oder nachgetragene Adressen gelten). Wer das Rundschreiben schon bekommen hat, bekommt es nicht noch einmal.'}
                     onCancel={() => setErneut(false)} onConfirm={() => { setErneut(false); aktion('erneut', {}); }} />
      {pdf && <PdfDialog url={`${RS}/${id}/pdf`} title={`Rundschreiben ${id}`} filename={`Rundschreiben_${id}.pdf`} onClose={() => setPdf(false)} />}
    </>
  );
}
