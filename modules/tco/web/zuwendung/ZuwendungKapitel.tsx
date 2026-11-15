import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, Button, CheckBox, DatePicker, Label, Link, MessageStrip, Option, Panel, Select, Text, TextArea, Input } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { FieldBox, FormGrid, TextField } from '@core/components/FormFields';
import { einstellungLink } from '@core/einstellungen';
import { toast } from '@core/toast';
import { TCO, dat, dateiLesen } from '../util';

const Z = `${TCO}/zuwendung`;

interface TextDef { schluessel: string; gruppe: string; name: string; standard: string; pflicht?: string[]; mehrzeilig?: boolean }
interface Cfg {
  bescheid_art: '' | 'FREISTELLUNG' | 'FESTSTELLUNG'; finanzamt: string; steuernummer: string; bescheid_datum: string | null; veranlagungszeitraum: string;
  zweck: string; zweck_satzung: string; unterzeichner: string; funktion: string; ort: string; unterschrift: string | null;
  spendenkonten: string[]; spendenarten: string[]; mail_erlaubt: boolean; texte: Record<string, string>;
  muster_geprueft_am: string | null; muster_geprueft_von: string | null;
  konten: { konto: string; name: string; vorschlag: boolean }[]; arten: { art: string; bezeichnung: string; erloeskonto: string; vorschlag: boolean }[];
  textbausteine: TextDef[]; platzhalter: Record<string, string>; bescheidarten: { id: string; text: string; jahre: number }[];
  fehlt: string[]; stand: { ok: boolean; text: string }; sperren: string[]; aussteller: { name: string; strasse: string | null; plz_ort: string | null };
}

/**
 * Kapitel „Zuwendungsbestätigungen“ der App Einstellungen: Angaben zur Steuerbegünstigung, Unterzeichner, Quellen der
 * Spenden (Konten, Beitragsarten), Versand und die Textbausteine der Bestätigung mit dem Abgleich gegen das amtliche Muster.
 */
export function ZuwendungKapitel() {
  const navigate = useNavigate();
  const [c, setC] = useState<Cfg | null>(null);
  const [geprueft, setGeprueft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnungen, setWarnungen] = useState<string[]>([]);
  const datei = useRef<HTMLInputElement>(null);
  const laden = () => api.get<Cfg>(`${Z}/einstellungen`).then((r) => { setC(r); setGeprueft(!!r.muster_geprueft_am); }).catch((e) => setError((e as Error).message));
  useEffect(() => { laden(); }, []);
  if (!c) return error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null;
  const s = <K extends keyof Cfg>(k: K) => (x: Cfg[K]) => setC({ ...c, [k]: x });
  const text = (k: 'finanzamt' | 'steuernummer' | 'veranlagungszeitraum' | 'zweck' | 'zweck_satzung' | 'unterzeichner' | 'funktion' | 'ort') => (x: string) => setC({ ...c, [k]: x });
  const umschalten = (k: 'spendenkonten' | 'spendenarten', wert: string, an: boolean) => setC({ ...c, [k]: an ? [...new Set([...c[k], wert])] : c[k].filter((x) => x !== wert) });
  const textGeaendert = (k: string, x: string) => { setC({ ...c, texte: { ...c.texte, [k]: x } }); setGeprueft(false); };
  const abweichend = c.textbausteine.filter((t) => (c.texte[t.schluessel] ?? t.standard).trim() !== t.standard).length;

  async function sichern() {
    if (!c) return;
    setError(null);
    try {
      const r = await api.put<{ warnungen: string[] }>(`${Z}/einstellungen`, {
        bescheid_art: c.bescheid_art, finanzamt: c.finanzamt, steuernummer: c.steuernummer, bescheid_datum: c.bescheid_datum, veranlagungszeitraum: c.veranlagungszeitraum,
        zweck: c.zweck, zweck_satzung: c.zweck_satzung, unterzeichner: c.unterzeichner, funktion: c.funktion, ort: c.ort, unterschrift: c.unterschrift,
        spendenkonten: c.spendenkonten, spendenarten: c.spendenarten, mail_erlaubt: c.mail_erlaubt, texte: c.texte, muster_geprueft: geprueft,
      });
      setWarnungen(r.warnungen);
      toast('Einstellungen gesichert');
      laden();
    } catch (e) { setError((e as Error).message); }
  }
  const gruppen = [...new Set(c.textbausteine.map((t) => t.gruppe))];

  return (
    <div style={{ maxWidth: '60rem' }}>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      {warnungen.map((w) => <MessageStrip key={w} design="Critical" onClose={() => setWarnungen(warnungen.filter((x) => x !== w))} style={{ marginBottom: '0.5rem' }}>{w}</MessageStrip>)}
      {!c.muster_geprueft_am && (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>
          <b>Vor der ersten Ausstellung: Wortlaut mit dem amtlichen Muster abgleichen.</b> Die Textbausteine unten sind dem amtlichen Muster des Bundesfinanzministeriums
          (BMF-Schreiben vom 07.11.2013, „Bestätigung über Geldzuwendungen/Mitgliedsbeitrag“ und „Sammelbestätigung“ für Körperschaften nach § 5 Abs. 1 Nr. 9 KStG) nachgebildet,
          aber nicht gegen die amtliche Fassung geprüft – sie sind keine amtlichen Texte. Bitte das aktuelle Muster (Formular-Management-System der Finanzverwaltung bzw. Finanzamt)
          danebenlegen, Abweichungen hier korrigieren und unter „Textbausteine“ bestätigen. Bis dahin ist die Ausstellung gesperrt.
        </MessageStrip>
      )}
      {c.sperren.length > 0
        ? <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '0.75rem' }}>Ausstellung gesperrt: {c.sperren.join(' ')}</MessageStrip>
        : <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.75rem' }}>Bestätigungen können ausgestellt werden. {c.stand.text}</MessageStrip>}

      <Panel headerText="Steuerbegünstigung (Bescheid des Finanzamts)" fixed>
        <FormGrid>
          <FieldBox label="Art des Bescheids" required>
            <Select onChange={(e) => s('bescheid_art')(((e.detail.selectedOption as HTMLElement).dataset.a ?? '') as Cfg['bescheid_art'])}>
              <Option data-a="" selected={!c.bescheid_art}>– bitte wählen –</Option>
              {c.bescheidarten.map((b) => <Option key={b.id} data-a={b.id} selected={c.bescheid_art === b.id}>{b.text} (höchstens {b.jahre} Jahre alt)</Option>)}
            </Select>
          </FieldBox>
          <FieldBox label="Datum des Bescheids" required>
            <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={c.bescheid_datum ?? ''} onChange={(e) => s('bescheid_datum')(e.detail.value || null)} />
          </FieldBox>
          <TextField label="Finanzamt" required value={c.finanzamt} onChange={text('finanzamt')} placeholder="St. Wendel" />
          <TextField label="Steuernummer" required value={c.steuernummer} onChange={text('steuernummer')} />
          {c.bescheid_art !== 'FESTSTELLUNG' && <TextField label="Letzter Veranlagungszeitraum laut Bescheid" required value={c.veranlagungszeitraum} onChange={text('veranlagungszeitraum')} placeholder="2021 bis 2023" />}
          <TextField label="Begünstigter Zweck („wegen … befreit“, „nur zur … verwendet“)" required value={c.zweck} onChange={text('zweck')} placeholder="Förderung des Sports" />
          {c.bescheid_art === 'FESTSTELLUNG' && <TextField label="Zweck im Satz „Wir fördern nach unserer Satzung …“" required value={c.zweck_satzung} onChange={text('zweck_satzung')} placeholder="den Sport" />}
        </FormGrid>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Ein Freistellungsbescheid (bzw. die Anlage zum Körperschaftsteuerbescheid) darf bei der Ausstellung höchstens 5 Jahre, ein Feststellungsbescheid nach § 60a AO höchstens 3 Jahre alt sein –
          danach sperrt das Portal die Ausstellung, bis der neue Bescheid hier eingetragen ist. Aussteller: {c.aussteller.name}, {c.aussteller.strasse ?? '–'}, {c.aussteller.plz_ort ?? '–'}{' '}
          (<Link onClick={() => navigate(einstellungLink('tco', 'verein'))}>Verein und Bank</Link>).
        </Text>
      </Panel>

      <Panel headerText="Unterzeichner" fixed style={{ marginTop: '0.75rem' }}>
        <FormGrid>
          <TextField label="Ort (vor dem Datum)" required value={c.ort} onChange={text('ort')} placeholder="Oberthal" />
          <TextField label="Unterzeichner" required value={c.unterzeichner} onChange={text('unterzeichner')} />
          <TextField label="Funktion" value={c.funktion} onChange={text('funktion')} placeholder="Kassenwart" />
          <FieldBox label="Unterschrift als Bild (optional, PNG/JPEG)">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {c.unterschrift && <img alt="Unterschrift" src={c.unterschrift} style={{ height: '2.5rem', background: '#fff', border: '1px solid var(--sapList_BorderColor)' }} />}
              <input ref={datei} type="file" accept="image/png,image/jpeg" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) s('unterschrift')(await dateiLesen(f)); e.target.value = ''; }} />
              <Button icon="upload" onClick={() => datei.current?.click()}>Bild wählen</Button>
              {c.unterschrift && <Button design="Transparent" icon="delete" onClick={() => s('unterschrift')(null)}>Entfernen</Button>}
            </div>
          </FieldBox>
        </FormGrid>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          Ohne Bild wird die Bestätigung gedruckt und von Hand unterschrieben. Eine maschinell erstellte Bestätigung ohne eigenhändige Unterschrift setzt nach den Einkommensteuer-Richtlinien
          (R 10b.1 Abs. 4 EStR) voraus, dass das Verfahren dem Finanzamt angezeigt wurde – bitte vor der Nutzung des Unterschriftsbilds und des E-Mail-Versands mit dem Finanzamt klären.
        </Text>
      </Panel>

      <Panel headerText="Was zählt als Spende?" fixed style={{ marginTop: '0.75rem' }}>
        <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
          Bestätigt werden nur Geldspenden, die tatsächlich eingegangen sind – nie Mitgliedsbeiträge (bei Sportvereinen nicht abziehbar), Trainings-, Hallen- oder Verzehrentgelte.
        </Text>
        <Label showColon>Spendenkonten (Einnahmen im Haben dieser Konten mit einem Geldkonto als Gegenkonto)</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 1rem', margin: '0.25rem 0 0.75rem' }}>
          {c.konten.filter((k) => k.vorschlag || c.spendenkonten.includes(k.konto)).map((k) => (
            <CheckBox key={k.konto} text={`${k.konto} ${k.name}`} checked={c.spendenkonten.includes(k.konto)} onChange={(e) => umschalten('spendenkonten', k.konto, e.target.checked)} />
          ))}
          <Select style={{ minWidth: '16rem' }} onChange={(e) => { const k = (e.detail.selectedOption as HTMLElement).dataset.k; if (k) umschalten('spendenkonten', k, true); }}>
            <Option data-k="" selected>weiteres Konto hinzufügen …</Option>
            {c.konten.filter((k) => !k.vorschlag && !c.spendenkonten.includes(k.konto)).map((k) => <Option key={k.konto} data-k={k.konto}>{k.konto} {k.name}</Option>)}
          </Select>
        </div>
        <Label showColon>Spenden-Beitragsarten (Lastschriften der Sollstellung – zählen erst nach der Verbuchung in den FI-Belegen)</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 1rem', marginTop: '0.25rem' }}>
          {c.arten.map((a) => (
            <CheckBox key={a.art} text={`${a.art} ${a.bezeichnung}${a.erloeskonto ? ` (Konto ${a.erloeskonto})` : ''}`} checked={c.spendenarten.includes(a.art)} onChange={(e) => umschalten('spendenarten', a.art, e.target.checked)} />
          ))}
          {!c.arten.length && <Text className="portal-muted">Im Beitragsstamm gibt es keine Beitragsarten.</Text>}
        </div>
      </Panel>

      <Panel headerText="Versand" fixed style={{ marginTop: '0.75rem' }}>
        <CheckBox checked={c.mail_erlaubt} onChange={(e) => s('mail_erlaubt')(e.target.checked)} wrappingType="Normal"
                  text="Versand der Bestätigung als PDF per E-Mail zulassen (sonst: drucken, unterschreiben, übergeben)" />
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.25rem' }}>
          Den Text der E-Mail pflegt das Kapitel <Link onClick={() => navigate(einstellungLink('tco', 'mailtexte'))}>E-Mail-Texte</Link> (Bereich Finanzen, „Zuwendungsbestätigung“).
          Lehnt der Versand eine Adresse ab (z. B. als unzustellbar vermerkt) oder schlägt er fehl, steht an der Bestätigung „Nicht versendet – bitte drucken“.
        </Text>
      </Panel>

      <Panel headerText={`Textbausteine der Bestätigung${abweichend ? ` (${abweichend} vom Verein geändert)` : ''}`} collapsed style={{ marginTop: '0.75rem' }}>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
          Platzhalter: {Object.entries(c.platzhalter).map(([k, t]) => `{${k}} = ${t}`).join(' · ')}. Ein geleertes Feld nimmt wieder die Vorgabe.
        </Text>
        {gruppen.map((g) => (
          <div key={g} style={{ marginBottom: '0.75rem' }}>
            <div className="portal-schnitt__bereich">{g}</div>
            {c.textbausteine.filter((t) => t.gruppe === g).map((t) => {
              const wert = c.texte[t.schluessel] ?? t.standard;
              const eigen = wert.trim() !== t.standard;
              return (
                <div key={t.schluessel} style={{ margin: '0.5rem 0' }}>
                  <Label showColon>{t.name}{eigen ? ' – geändert' : ''}</Label>
                  {t.mehrzeilig
                    ? <TextArea rows={3} value={wert} onInput={(e) => textGeaendert(t.schluessel, e.target.value)} />
                    : <Input style={{ width: '100%' }} value={wert} onInput={(e) => textGeaendert(t.schluessel, e.target.value)} />}
                  {eigen && <Link onClick={() => textGeaendert(t.schluessel, t.standard)}>Vorgabe wiederherstellen</Link>}
                </div>
              );
            })}
          </div>
        ))}
      </Panel>
      <div style={{ marginTop: '0.75rem' }}>
        <CheckBox checked={geprueft} onChange={(e) => setGeprueft(e.target.checked)} wrappingType="Normal"
                  text="Ich habe den Wortlaut der Textbausteine mit dem amtlichen Muster des BMF (Geldzuwendung/Mitgliedsbeitrag an eine Körperschaft nach § 5 Abs. 1 Nr. 9 KStG, Einzel- und Sammelbestätigung) abgeglichen." />
        {c.muster_geprueft_am && <Text className="portal-muted portal-small" style={{ display: 'block' }}>Zuletzt bestätigt am {dat(c.muster_geprueft_am)} von {c.muster_geprueft_von}. Nach einer Änderung der Textbausteine ist neu zu bestätigen.</Text>}
      </div>

      <Bar style={{ marginTop: '1rem' }} endContent={<>
        <ChangeHistoryButton objectType="ZUW_CFG" objectKey="1" />
        <Button design="Emphasized" icon="save" onClick={sichern}>Sichern</Button>
      </>} />
    </div>
  );
}
