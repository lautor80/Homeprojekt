import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Bar, BusyIndicator, Button, Dialog, MessageStrip, ObjectStatus, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AppPage } from '@core/components/AppPage';
import { Attribute, Attributes } from '@core/components/Attributes';
import { ChangeHistoryButton } from '@core/components/ChangeHistory';
import { ConfirmDialog } from '@core/components/ConfirmDialog';
import { IconAktionen } from '@core/components/IconAktionen';
import { ObjectHeader } from '@core/components/ObjectHeader';
import { Empty, Section } from '@core/components/Section';
import { useLoad } from '@core/components/useLoad';
import { useCan } from '@core/session';
import { toast } from '@core/toast';
import { dat, eur } from '../util';
import {
  ART_KURZ, FOTO_URL, MEDIUM_ICON, MONATE, Z, dieserMonat, faelligkeit, mediumText, mitEinheit, monatPlus, periodeText,
  prozent, standText, vEinheit, zahl,
} from './format';
import { KategorieLinien, SaeulenDiagramm, StandVerlauf } from './Diagramme';
import { QrDialog } from './QrCode';
import { StandErfassenDialog } from './StandErfassen';
import { ZaehlerStammDialog } from './Zaehlerstaende';
import type { Auswertung, Jahresvergleich, Kennzahlen, ZaehlerDetail as Detail, ZaehlerZeile, Zaehlerstand } from './typen';
import './zaehler.css';

/**
 * Objektseite eines Zählers (/tco/zaehler/:id): Kopf mit Fälligkeit, Kennzahlen, Diagramme (Zählerstand-Verlauf mit
 * Zählerwechsel, Monatsverbrauch der letzten 24 Monate mit geschätzten Monaten schraffiert, Jahresvergleich), Ablesungen
 * mit Ändern/Löschen (Begründung)/Foto, QR-Code für den Zähler und Änderungshistorie (Objekt ZAEHLER).
 */
export function ZaehlerDetail() {
  const { id } = useParams();
  const zid = Number(id);
  const navigate = useNavigate();
  const can = useCan();
  const darfErfassen = can('tco.zaehler:edit');
  const bis = dieserMonat(), von = monatPlus(bis, -23);
  const { data: d, error, reload } = useLoad(() => api.get<Detail>(`${Z}/${zid}`), [zid]);
  const jv = useLoad(() => api.get<Jahresvergleich>(`${Z}/${zid}/jahresvergleich`), [zid]);
  const mv = useLoad(() => api.get<Auswertung>(`${Z}/auswertung?ids=${zid}&von=${von}&bis=${bis}&raster=monat`), [zid, von, bis]);
  const [erfassen, setErfassen] = useState<Zaehlerstand | 'neu' | null>(null);
  const [loeschen, setLoeschen] = useState<Zaehlerstand | null>(null);
  const [foto, setFoto] = useState<Zaehlerstand | null>(null);
  const [qr, setQr] = useState(false);
  const [stamm, setStamm] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const allesNeu = () => { reload(); jv.reload(); mv.reload(); };
  async function standLoeschen(reason: string) {
    const s = loeschen!;
    setLoeschen(null);
    try {
      await api.del(`${Z}/staende/${s.id}`, { reason });
      toast('Zählerstand gelöscht');
      allesNeu();
    } catch (e) { setFehler((e as Error).message); }
  }

  if (!d) {
    return (
      <AppPage title="Zähler" actions={<Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/zaehler')}>Zur Übersicht</Button>}>
        {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      </AppPage>
    );
  }
  const z = d.zaehler, k = d.kennzahlen;
  const ve = vEinheit(z);
  const f = faelligkeit(k);
  const zeile: ZaehlerZeile = { ...z, kennzahlen: k, verlauf12: [] };
  const aufsteigend = [...d.staende].sort((a, b) => a.datum.localeCompare(b.datum) || a.id - b.id);

  return (
    <AppPage title={`Zähler ${z.nummer}`} subtitle={z.bezeichnung}
             actions={<>
               <Button icon="nav-back" design="Transparent" onClick={() => navigate('/tco/zaehler')}>Zur Übersicht</Button>
               {darfErfassen && z.aktiv && <Button design="Emphasized" icon="add" onClick={() => setErfassen('neu')}>Zählerstand erfassen</Button>}
               <Button icon="qr-code" onClick={() => setQr(true)}>QR-Code</Button>
               {can('tco.zaehler:admin') && <Button icon="edit" onClick={() => setStamm(true)}>Stammdaten ändern</Button>}
               <ChangeHistoryButton objectType="ZAEHLER" objectKey={z.nummer} />
             </>}>
      {fehler && <MessageStrip design="Negative" onClose={() => setFehler(null)} style={{ marginBottom: '0.5rem' }}>{fehler}</MessageStrip>}
      <ObjectHeader icon={MEDIUM_ICON[z.medium]} title={z.bezeichnung}
                      subtitle={`${z.nummer} · ${mediumText(z.medium)}${z.standort ? ` · ${z.standort}` : ''}`}
                      status={<>
                        {!z.aktiv && <ObjectStatus state="None" inverted>inaktiv</ObjectStatus>}
                        {z.aktiv && f.state !== 'None' && <ObjectStatus state={f.state} showDefaultIcon>{f.text}</ObjectStatus>}
                        {z.aktiv && f.state === 'None' && <ObjectStatus state="None">{f.text}</ObjectStatus>}
                        {k.zielUeberschritten && <ObjectStatus state="Critical" showDefaultIcon>Jahresziel wird voraussichtlich überschritten</ObjectStatus>}
                      </>}>
          <Attributes>
            <Attribute label="Letzte Ablesung">{k.letzteAblesung ? `${standText(k.letzteAblesung.stand)} ${z.einheit} am ${dat(k.letzteAblesung.datum)}` : null}</Attribute>
            <Attribute label="Nächste Ablesung fällig">{k.faelligAm ? dat(k.faelligAm) : null}</Attribute>
            <Attribute label="Zählernummer (Gerät)">{z.zaehlernummer}</Attribute>
            <Attribute label="Einheit / Faktor">{`${z.einheit || '–'}${z.faktor !== 1 ? ` × ${zahl(z.faktor, 4)} = ${ve}` : ''}`}</Attribute>
            <Attribute label="Ableseintervall">{z.intervall_tage ? `${z.intervall_tage} Tage` : null}</Attribute>
            <Attribute label="Preise">{z.arbeitspreis !== null || z.grundpreis_monat !== null
              ? `${z.arbeitspreis !== null ? `${eur(z.arbeitspreis)}/${ve}` : ''}${z.arbeitspreis !== null && z.grundpreis_monat !== null ? ' + ' : ''}${z.grundpreis_monat !== null ? `${eur(z.grundpreis_monat)}/Monat` : ''}`
              : null}</Attribute>
            {z.notiz && <Attribute label="Notiz" wide>{z.notiz}</Attribute>}
          </Attributes>
      </ObjectHeader>

      <Section title="Kennzahlen"><KennzahlKacheln k={k} einheit={ve} jahresziel={z.jahresziel} /></Section>

      <Section title="Zählerstand-Verlauf">
        {aufsteigend.length < 2 ? <Empty>Für einen Verlauf sind mindestens zwei Ablesungen nötig.</Empty> : (
          <StandVerlauf titel={`Zählerstand ${z.bezeichnung}`} fmt={(v) => `${standText(v)} ${z.einheit}`}
                        punkte={aufsteigend.map((s) => ({ datum: s.datum, stand: s.stand, art: s.art, text: `${dat(s.datum)} (${ART_KURZ[s.art]})` }))} />
        )}
      </Section>

      <Section title={`Monatsverbrauch ${periodeText(von, true)} – ${periodeText(bis, true)}`}>
        {mv.error ? <MessageStrip design="Negative" hideCloseButton>{mv.error}</MessageStrip> : !mv.data ? <BusyIndicator active /> : !mv.data.reihen[0]?.verbrauch.some((v) => v !== null) ? (
          <Empty>Noch kein Verbrauch in diesem Zeitraum.</Empty>
        ) : (
          <SaeulenDiagramm titel={`Monatsverbrauch ${z.bezeichnung} in ${ve}`} kategorien={mv.data.perioden} kategorieText={(p, schmal) => (schmal ? periodeText(p).slice(0, 3) : periodeText(p))}
                           fmt={(v) => mitEinheit(v, ve)}
                           reihen={[{ name: z.bezeichnung, farbe: 1, werte: mv.data.reihen[0].verbrauch, geschaetzt: mv.data.perioden.map((p) => monatGeschaetzt(p, aufsteigend)) }]} />
        )}
      </Section>

      <Section title="Jahresvergleich">
        {jv.error ? <MessageStrip design="Negative" hideCloseButton>{jv.error}</MessageStrip> : !jv.data ? <BusyIndicator active /> : !jv.data.jahre.length ? (
          <Empty>Noch keine Daten für einen Jahresvergleich.</Empty>
        ) : (
          <>
            <KategorieLinien titel={`Monatsverbrauch je Jahr in ${ve}`} kategorien={MONATE} fmt={(v) => mitEinheit(v, ve)}
                             reihen={jv.data.jahre.map((j) => ({ name: String(j.jahr), werte: j.monate, farbe: (j.jahr % 5) + 1 }))} />
            <Text className="portal-muted portal-small">
              {jv.data.jahre.map((j) => `${j.jahr}: ${mitEinheit(j.summe, ve)}`).join(' · ')}
            </Text>
          </>
        )}
      </Section>

      <Section title="Ablesungen" count={d.staende.length} flush>
        {!d.staende.length ? <Empty>Noch keine Ablesung erfasst.</Empty> : (
          <div className="portal-tabrahmen">
            <table className="zs-tabelle">
              <thead><tr>
                <th>Datum</th><th className="zahl">Stand ({z.einheit || '–'})</th><th>Art</th><th className="zahl">Verbrauch ({ve || '–'})</th>
                <th className="zahl">Ø je Tag</th><th>Notiz</th><th>Erfasst von</th><th>Foto</th>{darfErfassen && <th />}
              </tr></thead>
              <tbody>
                {d.staende.map((s) => (
                  <tr key={s.id}>
                    <td>{dat(s.datum)}</td>
                    <td className="zahl">{standText(s.stand)}</td>
                    <td><ObjectStatus state={s.art === 'SCHAETZUNG' ? 'Critical' : s.art === 'ABLESUNG' ? 'None' : 'Information'}>{ART_KURZ[s.art]}</ObjectStatus></td>
                    <td className="zahl">{zahl(s.verbrauch)}</td>
                    <td className="zahl">{zahl(s.tagesverbrauch)}</td>
                    <td className="umbruch">{s.notiz ?? ''}</td>
                    <td>{s.erfasstVon ?? ''}</td>
                    <td>{s.hatFoto && <Button design="Transparent" icon="camera" tooltip="Foto ansehen" onClick={() => setFoto(s)} />}</td>
                    {darfErfassen && (
                      <td><IconAktionen items={[
                        { text: 'Ändern', icon: 'edit', onClick: () => setErfassen(s) },
                        { text: 'Löschen', icon: 'delete', onClick: () => setLoeschen(s) },
                      ]} /></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {erfassen && (
        <StandErfassenDialog zaehler={[zeile]} zaehlerId={z.id} bearbeiten={erfassen === 'neu' ? undefined : erfassen}
                             onClose={() => setErfassen(null)} onGespeichert={() => { setErfassen(null); allesNeu(); }} />
      )}
      <ConfirmDialog open={!!loeschen} danger askReason title="Zählerstand löschen" confirmText="Löschen"
                     text={loeschen ? `Ablesung vom ${dat(loeschen.datum)} (${standText(loeschen.stand)} ${z.einheit}) löschen? Der Verbrauch wird ohne sie neu berechnet; die Löschung bleibt im Änderungsbeleg nachvollziehbar.` : ''}
                     onConfirm={standLoeschen} onCancel={() => setLoeschen(null)} />
      {foto && (
        <Dialog open headerText={`Foto der Ablesung vom ${dat(foto.datum)}`} onClose={() => setFoto(null)} style={{ width: 'min(52rem, 96vw)' }}
                footer={<Bar endContent={<>
                  <Button icon="action" onClick={() => window.open(FOTO_URL(foto.id), '_blank', 'noopener')}>In neuem Tab</Button>
                  <Button onClick={() => setFoto(null)}>Schließen</Button>
                </>} />}>
          <img src={FOTO_URL(foto.id)} alt={`Zählwerk am ${dat(foto.datum)}`} style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0 auto' }} />
        </Dialog>
      )}
      {qr && <QrDialog id={z.id} nummer={z.nummer} bezeichnung={z.bezeichnung} standort={z.standort} onClose={() => setQr(false)} />}
      {stamm && <ZaehlerStammDialog zaehler={z} onClose={() => setStamm(false)} onGesichert={() => { setStamm(false); allesNeu(); }} />}
    </AppPage>
  );
}

/** Kennzahlen als Kacheln: große Zahl, Beschriftung darüber, Status über die Farbe der Kennzahl (wie HeaderKpi) */
export function KennzahlKacheln({ k, einheit, jahresziel }: { k: Kennzahlen; einheit: string; jahresziel: number | null }) {
  const veraendert = k.veraenderungProzent;
  const wert = (v: string, state: 'None' | 'Positive' | 'Negative' | 'Critical' = 'None') => <span className={`portal-kpi__value portal-kpi__value--${state}`}>{v}</span>;
  return (
    <Attributes narrow>
      <Attribute label="Ø Verbrauch je Tag">{wert(mitEinheit(k.tagesdurchschnitt, einheit))}</Attribute>
      <Attribute label="Laufendes Jahr">{wert(mitEinheit(k.verbrauchJahr, einheit))}</Attribute>
      <Attribute label="Vorjahr">{wert(mitEinheit(k.verbrauchVorjahr, einheit))}</Attribute>
      <Attribute label="Prognose Jahr">
        {wert(mitEinheit(k.prognoseJahr, einheit))}
        {veraendert !== null && (
          <div><ObjectStatus state={veraendert > 5 ? 'Critical' : veraendert < -5 ? 'Positive' : 'None'}>{`${prozent(veraendert)} ggü. Vorjahr`}</ObjectStatus></div>
        )}
      </Attribute>
      <Attribute label="Kosten-Prognose Jahr">{wert(k.kostenPrognoseJahr !== null ? eur(k.kostenPrognoseJahr) : '–')}</Attribute>
      <Attribute label="Jahresziel">
        {jahresziel !== null ? wert(mitEinheit(jahresziel, einheit), k.zielUeberschritten ? 'Negative' : 'Positive') : wert('–')}
      </Attribute>
    </Attributes>
  );
}

/**
 * Monat geschätzt? Die Auswertung liefert keinen Hinweis je Periode; abgeleitet aus den Ablesungen: Ist eine der Ablesungen,
 * aus denen der Monatsverbrauch interpoliert wird (letzte vor Monatsbeginn bis erste ab Monatsende), eine Schätzung, gilt
 * der Monat als geschätzt.
 */
function monatGeschaetzt(periode: string, staende: Zaehlerstand[]): boolean {
  const start = `${periode}-01`, ende = `${monatPlus(periode, 1)}-01`;
  let a = -1, b = -1;
  staende.forEach((s, i) => { if (s.datum <= start) a = i; if (b < 0 && s.datum >= ende) b = i; });
  if (a < 0 && b < 0) return false;
  const von = Math.max(0, a), bis = b < 0 ? staende.length - 1 : b;
  return staende.slice(von, bis + 1).some((s) => s.art === 'SCHAETZUNG');
}
