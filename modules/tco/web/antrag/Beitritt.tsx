import { useEffect, useState, type ReactNode } from 'react';
import {
  Button, BusyIndicator, CheckBox, DatePicker, FlexBox, Input, Label, MessageStrip, Option, Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { TCO, eur } from '../util';

/**
 * Öffentlicher Mitgliedsantrag /beitritt (ohne Anmeldung): eine oder mehrere Personen (Familienantrag) mit gemeinsamer
 * Anschrift, Beitragsart je Person, SEPA-Lastschriftmandat online. Der Antrag geht in den Eingang; der Vorstand prüft und übernimmt.
 */
interface Art { art: string; name: string; betrag: number; turnus: string; kategorie: 'MITGLIEDSCHAFT' | 'TRAINING'; jugend: boolean; familie: boolean }
interface Info { verein: string; maxPersonen: number; maxTraining: number; alterJugendbeitragBis: number; alterTrainingBis: number; kuendigung: string; beitragsarten: Art[] }
interface Person { anrede: string; vorname: string; nachname: string; geburtsdatum: string; email: string; telefon: string; art: string; training: string[] }
const leer = (): Person => ({ anrede: '', vorname: '', nachname: '', geburtsdatum: '', email: '', telefon: '', art: '', training: [] });
const heute = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
const full = { width: '100%' };
const alter = (geb: string, stichtag = heute()) => {
  if (!geb) return null;
  const [j, m, d] = geb.split('-').map(Number);
  const [hj, hm, hd] = stichtag.split('-').map(Number);
  return hj - j - (hm < m || (hm === m && hd < d) ? 1 : 0);
};

function Feld({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <FlexBox direction="Column" style={{ gap: '0.25rem', marginBottom: '0.6rem', flex: 1, minWidth: '10rem' }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </FlexBox>
  );
}

export function Beitritt({ orgName, logo, onFertig }: OeffentlichProps) {
  const [info, setInfo] = useState<Info | null>(null);
  const [personen, setPersonen] = useState<Person[]>([leer()]);
  const [a, setA] = useState({ strasse: '', plz: '', ort: '', email: '', telefon: '', erziehungsberechtigt: '', eintritt: heute(), bemerkung: '', website: '' });
  const [bank, setBank] = useState({ kontoinhaber: '', iban: '', bic: '', bank: '', sepa: false });
  const [zu, setZu] = useState({ satzung: false, datenschutz: false, bildrechte: false, kuendigung: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState<string | null>(null);
  /** Beitrittslink aus dem Schnuppertraining (#86): Angaben vorbelegen, bei der Übernahme wird derselbe Stammsatz Mitglied */
  const [schnupper] = useState(() => new URLSearchParams(window.location.search).get('schnupper'));
  const [schnupperNr, setSchnupperNr] = useState<string | null>(null);
  /** Vertragsangebot (#12): vom Verein vorbereiteter Antrag – Link mit Schlüssel, Öffnen mit Geburtsdatum */
  const [angebot] = useState(() => new URLSearchParams(window.location.search).get('angebot'));
  const [angebotNr, setAngebotNr] = useState<string | null>(null);
  const [angebotHinweis, setAngebotHinweis] = useState<string | null>(null);
  const [tor, setTor] = useState<'laden' | 'geburtsdatum' | 'offen' | null>(() => (new URLSearchParams(window.location.search).get('angebot') ? 'laden' : null));
  const [torGeb, setTorGeb] = useState('');
  const [torFehler, setTorFehler] = useState<string | null>(null);
  useEffect(() => { api.get<Info>(`${TCO}/antrag`).then(setInfo).catch((e) => setError(e.message)); }, []);
  interface AngebotAntwort {
    geburtsdatumNoetig?: boolean; nummer?: string;
    daten?: { personen: { anrede: string; vorname: string; nachname: string; geburtsdatum: string | null; email?: string | null; telefon?: string | null; art?: string | null; training: string[] }[];
      strasse: string; plz: string; ort: string; email: string; telefon: string | null; erziehungsberechtigt: string | null; eintritt: string; bemerkung: string | null };
  }
  async function angebotOeffnen(geb: string | null) {
    setTorFehler(null);
    try {
      const r = await api.post<AngebotAntwort>(`${TCO}/antrag/angebot`, { token: angebot, geburtsdatum: geb });
      if (r.geburtsdatumNoetig || !r.daten) { setTor('geburtsdatum'); return; }
      const d = r.daten;
      setAngebotNr(r.nummer ?? null);
      setAngebotHinweis(d.bemerkung);
      setPersonen(d.personen.map((p, i) => ({
        anrede: p.anrede || '', vorname: p.vorname, nachname: p.nachname, geburtsdatum: p.geburtsdatum ?? '',
        email: i === 0 ? '' : p.email ?? '', telefon: i === 0 ? '' : p.telefon ?? '', art: i === 0 ? p.art ?? '' : '', training: p.training ?? [],
      })));
      setA((x) => ({ ...x, strasse: d.strasse, plz: d.plz, ort: d.ort, email: d.email, telefon: d.telefon ?? '', erziehungsberechtigt: d.erziehungsberechtigt ?? '', eintritt: d.eintritt }));
      setTor('offen');
    } catch (e) {
      // falsches Geburtsdatum (Versuche werden gezählt), Link abgelaufen/verwendet/gesperrt
      setTorFehler((e as Error).message);
      setTor('geburtsdatum');
    }
  }
  useEffect(() => { if (angebot) angebotOeffnen(null); }, [angebot]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!schnupper) return;
    api.get<{ nummer: string; vorname: string; nachname: string; email: string; mobil: string; erziehungsberechtigt: string }>(`${TCO}/schnupper/beitritt?token=${encodeURIComponent(schnupper)}`)
      .then((v) => {
        setSchnupperNr(v.nummer);
        setPersonen((l) => l.map((p, i) => (i === 0 ? { ...p, vorname: p.vorname || v.vorname, nachname: p.nachname || v.nachname } : p)));
        setA((x) => ({ ...x, email: x.email || v.email, telefon: x.telefon || v.mobil, erziehungsberechtigt: x.erziehungsberechtigt || v.erziehungsberechtigt }));
      })
      .catch((e) => setError(e.message));
  }, [schnupper]);

  const setP = (i: number, p: Partial<Person>) => setPersonen((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const minderjaehrig = (alter(personen[0].geburtsdatum) ?? 99) < 18;
  /** weitere Personen nur mit Familienbeitrag – sie sind darüber Mitglied (keine eigene Mitgliedschaft) */
  const familie = !!info?.beitragsarten.find((b) => b.art === personen[0].art)?.familie;
  /** Alter am gewünschten Eintritt: Jugendbeitrag nur unter 18, Jugendtraining nur bis 21 */
  const alterBeiEintritt = (p: Person) => alter(p.geburtsdatum, a.eintritt || heute());
  const mitgliedschaften = (p: Person) => (info?.beitragsarten ?? []).filter((b) => b.kategorie === 'MITGLIEDSCHAFT'
    && (!b.jugend || (alterBeiEintritt(p) ?? 0) <= (info?.alterJugendbeitragBis ?? 17)));
  // Training bis 21 Jahre; ohne Geburtsdatum schon anbieten (Prüfung nach Eingabe)
  const trainings = (p: Person) => ((alterBeiEintritt(p) ?? 0) <= (info?.alterTrainingBis ?? 21) ? (info?.beitragsarten ?? []).filter((b) => b.kategorie === 'TRAINING') : []);
  // Auswahl bereinigen, wenn das Geburtsdatum/Eintritt eine Option ausschließt
  useEffect(() => {
    if (!info) return;
    setPersonen((l) => {
      let geaendert = false;
      const neu = l.map((p, i) => {
        const m = i > 0 ? '' : mitgliedschaften(p).some((b) => b.art === p.art) ? p.art : '';
        const t = trainings(p).length ? p.training : [];
        if (m !== p.art || t !== p.training) { geaendert = true; return { ...p, art: m, training: t }; }
        return p;
      });
      return geaendert ? neu : l;
    });
  }, [info, a.eintritt, personen.map((p) => p.geburtsdatum).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = personen.every((p, i) => p.anrede && p.vorname.trim() && p.nachname.trim() && p.geburtsdatum && (i > 0 || p.art)) && (personen.length === 1 || familie)
    && a.strasse.trim() && a.plz.trim() && a.ort.trim() && a.email.trim() && (!minderjaehrig || a.erziehungsberechtigt.trim())
    && bank.kontoinhaber.trim() && bank.iban.trim() && bank.sepa && zu.satzung && zu.datenschutz && zu.kuendigung;

  async function absenden() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${TCO}/antrag`, {
        personen: personen.map((p, i) => ({ ...p, art: i === 0 ? p.art : null, email: (i === 0 ? a.email : p.email) || null, telefon: (i === 0 ? a.telefon : p.telefon) || null })),
        strasse: a.strasse, plz: a.plz, ort: a.ort, email: a.email, telefon: a.telefon || null,
        erziehungsberechtigt: minderjaehrig ? a.erziehungsberechtigt : null, eintritt: a.eintritt, bemerkung: a.bemerkung || null,
        ...zu, bank, website: a.website, schnupper: schnupperNr ? schnupper : null, angebot: angebotNr ? angebot : null,
      });
      setFertig(r.text);
      window.scrollTo(0, 0);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (fertig) {
    return (
      <CenterCard title={orgName} subtitle="Mitgliedsantrag" logo={logo}>
        <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{fertig}</MessageStrip>
        <Button design="Emphasized" style={full} onClick={onFertig}>Zum Portal</Button>
      </CenterCard>
    );
  }
  // Vertragsangebot: erst nach dem Geburtsdatum werden die vorbereiteten Angaben geladen
  if (tor === 'laden' || tor === 'geburtsdatum') {
    return (
      <CenterCard title={orgName} subtitle="Ihr persönlicher Mitgliedsantrag" logo={logo}>
        {tor === 'laden' && !torFehler ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
          <form onSubmit={(e) => { e.preventDefault(); if (torGeb) angebotOeffnen(torGeb); }}>
            <Text style={{ display: 'block', marginBottom: '0.75rem' }}>
              Der Verein hat Ihren Mitgliedsantrag mit dem vorgeschlagenen Vertrag vorbereitet. Zum Schutz Ihrer Daten bestätigen Sie bitte Ihr Geburtsdatum
              {' '}(bei Kindern und Jugendlichen das Geburtsdatum des Kindes, für das der Antrag gestellt wird).
            </Text>
            {torFehler && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>{torFehler}</MessageStrip>}
            <Feld label="Geburtsdatum" required>
              <DatePicker style={full} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={torGeb} onChange={(e) => setTorGeb(e.detail.value)} />
            </Feld>
            <Button design="Emphasized" style={full} disabled={!torGeb} onClick={() => angebotOeffnen(torGeb)}>Antrag öffnen</Button>
          </form>
        )}
      </CenterCard>
    );
  }
  return (
    <CenterCard title={orgName} subtitle="Mitgliedsantrag" logo={logo} breit>
      {!info ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
        <form onSubmit={(e) => { e.preventDefault(); if (ok) absenden(); }}>
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
            Werden Sie Mitglied im {info.verein}. Mit dem Familienbeitrag nehmen Sie weitere Familienmitglieder in denselben Antrag auf; Jugendliche bis 21 Jahre können bis zu zwei Trainingseinheiten dazubuchen. Der Beitrag wird per SEPA-Lastschrift vom angegebenen Konto eingezogen.
          </Text>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
          {angebotNr && (
            <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>
              Ihr Vertragsangebot {angebotNr}: Personen, Mitgliedschaft und Training sind bereits eingetragen. Bitte prüfen, die Bankverbindung für das
              {' '}SEPA-Lastschriftmandat ergänzen und unten bestätigen.{angebotHinweis ? ` Hinweis des Vereins: ${angebotHinweis}` : ''}
            </MessageStrip>
          )}
          {schnupperNr && (
            <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>
              Schön, dass es dir beim Schnuppertraining gefallen hat! Deine Angaben aus der Anmeldung {schnupperNr} sind bereits eingetragen – bitte ergänzen.
            </MessageStrip>
          )}

          {personen.map((p, i) => (
            <div key={i} style={{ padding: '0.75rem', marginBottom: '0.75rem', border: '1px solid var(--sapList_BorderColor)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
              <FlexBox justifyContent="SpaceBetween" alignItems="Center">
                <Title level="H5">{i === 0 ? 'Antragsteller/in (Hauptmitglied)' : `Weitere Person ${i}`}</Title>
                {i > 0 && <Button design="Transparent" icon="delete" onClick={() => setPersonen((l) => l.filter((_, j) => j !== i))}>Entfernen</Button>}
              </FlexBox>
              <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                <Feld label="Anrede" required>
                  <Select style={full} onChange={(e) => setP(i, { anrede: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
                    <Option data-a="" selected={!p.anrede}>bitte wählen</Option>
                    {['Frau', 'Herr', 'Divers'].map((x) => <Option key={x} data-a={x} selected={p.anrede === x}>{x}</Option>)}
                  </Select>
                </Feld>
                <Feld label="Vorname" required><Input style={full} value={p.vorname} onInput={(e) => setP(i, { vorname: e.target.value })} /></Feld>
                <Feld label="Nachname" required><Input style={full} value={p.nachname} onInput={(e) => setP(i, { nachname: e.target.value })} /></Feld>
              </FlexBox>
              <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                <Feld label="Geburtsdatum" required>
                  <DatePicker style={full} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={p.geburtsdatum} onChange={(e) => setP(i, { geburtsdatum: e.detail.value })} />
                </Feld>
                {i === 0 ? (
                  <Feld label="Mitgliedschaft" required>
                    <Select style={full} onChange={(e) => setP(i, { art: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' })}>
                      <Option data-a="" selected={!p.art}>bitte wählen</Option>
                      {mitgliedschaften(p).map((b) => <Option key={b.art} data-a={b.art} selected={p.art === b.art}>{b.name} – {eur(b.betrag)}{b.turnus ? ` (${b.turnus})` : ''}</Option>)}
                    </Select>
                  </Feld>
                ) : (
                  <Feld label="Mitgliedschaft">
                    <Text style={{ paddingTop: '0.5rem' }}>über den Familienbeitrag</Text>
                  </Feld>
                )}
              </FlexBox>
              {trainings(p).length > 0 && (
                <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  {Array.from({ length: info.maxTraining }, (_, n) => (
                    <Feld key={n} label={`Trainingseinheit ${n + 1} (optional)`}>
                      <Select style={full} disabled={n > 0 && !p.training[0]} onChange={(e) => {
                        const x = (e.detail.selectedOption as HTMLElement).dataset.a ?? '';
                        const t = [...p.training];
                        if (x) t[n] = x; else t.splice(n, 1);
                        setP(i, { training: t.filter(Boolean).slice(0, info.maxTraining) });
                      }}>
                        <Option data-a="" selected={!p.training[n]}>keine</Option>
                        {trainings(p).map((b) => <Option key={b.art} data-a={b.art} selected={p.training[n] === b.art}>{b.name} – {eur(b.betrag)}{b.turnus ? ` (${b.turnus})` : ''}</Option>)}
                      </Select>
                    </Feld>
                  ))}
                </FlexBox>
              )}
              {p.geburtsdatum && !trainings(p).length && info.beitragsarten.some((b) => b.kategorie === 'TRAINING') && (
                <Text className="portal-muted portal-small">Jugendtraining wird bis {info.alterTrainingBis} Jahre angeboten.</Text>
              )}
              {i > 0 && (
                <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Feld label="E-Mail (optional, sonst die des Antragstellers)"><Input style={full} type="Email" value={p.email} onInput={(e) => setP(i, { email: e.target.value })} /></Feld>
                  <Feld label="Telefon (optional)"><Input style={full} type="Tel" value={p.telefon} onInput={(e) => setP(i, { telefon: e.target.value })} /></Feld>
                </FlexBox>
              )}
            </div>
          ))}
          {familie && personen.length < info.maxPersonen && (
            <Button design="Transparent" icon="add-employee" onClick={() => setPersonen((l) => [...l, { ...leer(), nachname: l[0].nachname }])} style={{ marginBottom: '0.75rem' }}>
              Weitere Person (Familie) hinzufügen
            </Button>
          )}
          {!familie && personen.length === 1 && info.beitragsarten.some((b) => b.familie) && (
            <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.75rem' }}>
              Mehrere Personen (Familie)? Dann beim Antragsteller den Familienbeitrag wählen – weitere Personen sind darüber Mitglied und können Jugendtraining dazubuchen.
            </Text>
          )}
          {!familie && personen.length > 1 && (
            <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>
              Weitere Personen sind nur mit dem Familienbeitrag möglich – bitte beim Antragsteller den Familienbeitrag wählen oder die weiteren Personen entfernen.
            </MessageStrip>
          )}

          <Title level="H5" style={{ margin: '0.5rem 0' }}>Anschrift und Kontakt</Title>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="Straße und Hausnummer" required><Input style={full} value={a.strasse} onInput={(e) => setA({ ...a, strasse: e.target.value })} /></Feld>
          </FlexBox>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="PLZ" required><Input style={full} value={a.plz} onInput={(e) => setA({ ...a, plz: e.target.value })} /></Feld>
            <Feld label="Ort" required><Input style={full} value={a.ort} onInput={(e) => setA({ ...a, ort: e.target.value })} /></Feld>
          </FlexBox>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="E-Mail" required><Input style={full} type="Email" value={a.email} onInput={(e) => setA({ ...a, email: e.target.value })} /></Feld>
            <Feld label="Telefon (optional)"><Input style={full} type="Tel" value={a.telefon} onInput={(e) => setA({ ...a, telefon: e.target.value })} /></Feld>
          </FlexBox>
          {minderjaehrig && (
            <Feld label="Erziehungsberechtigte/r (stellt den Antrag)" required>
              <Input style={full} value={a.erziehungsberechtigt} onInput={(e) => setA({ ...a, erziehungsberechtigt: e.target.value })} />
            </Feld>
          )}
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="Gewünschter Eintritt" required>
              <DatePicker style={full} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={a.eintritt} onChange={(e) => setA({ ...a, eintritt: e.detail.value })} />
            </Feld>
          </FlexBox>
          <Beitraege info={info} personen={personen} eintritt={a.eintritt || heute()} />

          <Title level="H5" style={{ margin: '0.5rem 0' }}>SEPA-Lastschriftmandat</Title>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="Kontoinhaber/in" required><Input style={full} value={bank.kontoinhaber} placeholder="Vorname Nachname" onInput={(e) => setBank({ ...bank, kontoinhaber: e.target.value })} /></Feld>
            <Feld label="IBAN" required><Input style={full} value={bank.iban} onInput={(e) => setBank({ ...bank, iban: e.target.value })} /></Feld>
          </FlexBox>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="BIC (optional)"><Input style={full} value={bank.bic} onInput={(e) => setBank({ ...bank, bic: e.target.value })} /></Feld>
            <Feld label="Bank (optional)"><Input style={full} value={bank.bank} onInput={(e) => setBank({ ...bank, bank: e.target.value })} /></Feld>
          </FlexBox>
          <CheckBox wrappingType="Normal" checked={bank.sepa} onChange={(e) => setBank({ ...bank, sepa: e.target.checked })} style={{ marginLeft: '-0.5rem' }}
                    text={`Ich ermächtige den ${info.verein}, Zahlungen (Mitgliedsbeiträge) von meinem Konto mittels Lastschrift einzuziehen. Zugleich weise ich mein Kreditinstitut an, die vom Verein auf mein Konto gezogenen Lastschriften einzulösen. Ich kann innerhalb von acht Wochen, beginnend mit dem Belastungsdatum, die Erstattung des belasteten Betrages verlangen. Es gelten dabei die mit meinem Kreditinstitut vereinbarten Bedingungen. Die Mandatsreferenz wird mir mit der Aufnahme mitgeteilt.`} />

          <Title level="H5" style={{ margin: '0.75rem 0 0.5rem' }}>Zustimmungen</Title>
          <CheckBox wrappingType="Normal" checked={zu.satzung} onChange={(e) => setZu({ ...zu, satzung: e.target.checked })} style={{ marginLeft: '-0.5rem' }}
                    text="Ich erkenne die Satzung und die Beitragsordnung des Vereins an. *" />
          <CheckBox wrappingType="Normal" checked={zu.datenschutz} onChange={(e) => setZu({ ...zu, datenschutz: e.target.checked })} style={{ marginLeft: '-0.5rem' }}
                    text="Ich habe die Datenschutzhinweise gelesen und bin mit der Verarbeitung meiner Daten zur Mitgliederverwaltung einverstanden. *" />
          <CheckBox wrappingType="Normal" checked={zu.bildrechte} onChange={(e) => setZu({ ...zu, bildrechte: e.target.checked })} style={{ marginLeft: '-0.5rem' }}
                    text="Fotos von Vereinsveranstaltungen, auf denen ich/wir zu sehen sind, dürfen in Vereinsmedien veröffentlicht werden (freiwillig)." />
          <Title level="H5" style={{ margin: '0.75rem 0 0.5rem' }}>Kündigungsfristen</Title>
          <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.4rem' }}>{info.kuendigung}</MessageStrip>
          <CheckBox wrappingType="Normal" checked={zu.kuendigung} onChange={(e) => setZu({ ...zu, kuendigung: e.target.checked })} style={{ marginLeft: '-0.5rem' }}
                    text="Ich habe die Kündigungsfristen zur Kenntnis genommen: Vereinsmitgliedschaft 4 Wochen zum Jahresende, Trainingsteilnahme zum 30.09. eines jeden Jahres. *" />
          <Feld label="Mitteilung an den Vorstand (optional)"><TextArea rows={2} value={a.bemerkung} maxlength={1000} onInput={(e) => setA({ ...a, bemerkung: e.target.value })} /></Feld>
          {/* Honigtopf: für Menschen unsichtbar */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={a.website} onChange={(e) => setA({ ...a, website: e.target.value })}
                 style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} aria-hidden />
          <Button design="Emphasized" style={full} onClick={absenden} loading={busy} disabled={!ok}>Antrag verbindlich absenden</Button>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>* Pflichtangaben. Nach der Prüfung erhalten Sie die Aufnahmebestätigung und Ihre Zugangsdaten zum Mitgliederportal per E-Mail.</Text>
        </form>
      )}
    </CenterCard>
  );
}

/**
 * Beginn wie bei der Übernahme (mitglieder/logik.ts → vertragsbeginn): Mitgliedsbeiträge zum nächsten 1.1. bzw. 1.7.,
 * Jugendtraining zum nächsten Monatsbeginn (jeweils der Eintritt selbst, wenn er auf diesen Tag fällt).
 */
export function beginnFuer(eintritt: string, kategorie: 'MITGLIEDSCHAFT' | 'TRAINING'): string {
  const j = Number(eintritt.slice(0, 4)), m = Number(eintritt.slice(5, 7)), t = eintritt.slice(8, 10);
  if (kategorie === 'TRAINING') return t === '01' ? eintritt : m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
  const md = eintritt.slice(5);
  if (md === '01-01' || md === '07-01') return eintritt;
  return m <= 6 ? `${j}-07-01` : `${j + 1}-01-01`;
}
const datum = (iso: string) => iso.split('-').reverse().join('.');

/** Beitragsübersicht: Mitgliedschaft und Jugendtraining getrennt, je Position Betrag, Turnus und Beginn (erste Fälligkeit) */
function Beitraege({ info, personen, eintritt }: { info: Info; personen: Person[]; eintritt: string }) {
  const art = (x: string) => info.beitragsarten.find((b) => b.art === x);
  const name = (p: Person, i: number) => `${p.vorname || (i === 0 ? 'Antragsteller/in' : `Person ${i + 1}`)} ${p.nachname}`.trim();
  const mitglied = personen.flatMap((p, i) => {
    if (i === 0) { const b = art(p.art); return b ? [{ wer: name(p, i), text: b.name, betrag: b.betrag, turnus: b.turnus }] : []; }
    return [{ wer: name(p, i), text: 'über den Familienbeitrag', betrag: 0, turnus: '' }];
  });
  const training = personen.flatMap((p, i) => p.training.map((x) => art(x)).filter((b): b is Art => !!b)
    .map((b) => ({ wer: name(p, i), text: b.name, betrag: b.betrag, turnus: b.turnus })));
  const zelle = { padding: '0.25rem 0.4rem' } as const;
  const summe = (l: { betrag: number; turnus: string }[]) => {
    const je = new Map<string, number>();
    for (const x of l) if (x.betrag) je.set(x.turnus, (je.get(x.turnus) ?? 0) + x.betrag);
    return [...je].map(([t, b]) => `${eur(b)}${t ? ` ${t}` : ''}`).join(' + ') || eur(0);
  };
  const block = (titel: string, kategorie: 'MITGLIEDSCHAFT' | 'TRAINING', zeilen: { wer: string; text: string; betrag: number; turnus: string }[], hinweis: string) => {
    const beginn = beginnFuer(eintritt, kategorie);
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <Title level="H6" style={{ marginBottom: '0.25rem' }}>{titel}</Title>
        {!zeilen.length ? <Text className="portal-muted">–</Text> : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{['Person', 'Beitrag', 'Turnus', 'Betrag'].map((h, n) => <th key={h} style={{ ...zelle, textAlign: n === 3 ? 'right' : 'left' }}><Label>{h}</Label></th>)}</tr></thead>
            <tbody>
              {zeilen.map((z, n) => (
                <tr key={n} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                  <td style={zelle}><Text>{z.wer}</Text></td>
                  <td style={zelle}><Text>{z.text}</Text></td>
                  <td style={zelle}><Text>{z.turnus || '–'}</Text></td>
                  <td style={{ ...zelle, textAlign: 'right' }}><Text>{z.betrag ? eur(z.betrag) : 'inklusive'}</Text></td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                <td style={zelle} colSpan={3}><Text style={{ fontWeight: 'bold' }}>Summe {titel}</Text></td>
                <td style={{ ...zelle, textAlign: 'right' }}><Text style={{ fontWeight: 'bold' }}>{summe(zeilen)}</Text></td>
              </tr>
            </tbody>
          </table>
        )}
        {zeilen.length > 0 && (
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.2rem' }}>
            Beginn und erste Fälligkeit: <b>{datum(beginn)}</b> – {hinweis}
          </Text>
        )}
      </div>
    );
  };
  return (
    <div style={{ padding: '0.75rem', margin: '0.25rem 0 0.75rem', border: '1px solid var(--sapList_BorderColor)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
      <Title level="H5" style={{ marginBottom: '0.5rem' }}>Beiträge und Fälligkeit</Title>
      {block('Mitgliedschaft', 'MITGLIEDSCHAFT', mitglied, 'Mitgliedsbeiträge beginnen zum nächsten 1.1. bzw. 1.7.')}
      {block('Jugendtraining', 'TRAINING', training, 'Jugendtraining beginnt zum nächsten Monatsbeginn.')}
      <Text className="portal-muted portal-small" style={{ display: 'block' }}>Der Einzug erfolgt per SEPA-Lastschrift zur jeweiligen Fälligkeit.</Text>
    </div>
  );
}
