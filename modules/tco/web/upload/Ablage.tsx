import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bar, BusyIndicator, Button, Dialog, Icon, Link, MessageStrip, Text, IllustratedMessage } from '@ui5/webcomponents-react';
import '@ui5/webcomponents-fiori/dist/illustrations/DragFilesToUpload.js';
import { useNavigate } from 'react-router-dom';
import { api } from '@core/api';
import { useSession } from '@core/session';
import { useAblage, useAblageZiel } from '@core/ablage';
import { toast } from '@core/toast';
import { dateiLesen } from '../util';
import { UP } from './Upload';
import { LEER, MetaFelder, metaFuerUpload, vorgabeLesen, vorgabeSpeichern, vorgabeText, type Stamm, type Vorgabe } from './MetaFelder';
import './ablage.css';

/**
 * Ablagefeld unten in der linken Navigation: Dateien hineinziehen (oder antippen und wählen) –
 * sie werden sofort mit der Voreinstellung (Dokumenttyp, Korrespondent, Tags, Speicherpfad) nach Paperless übertragen.
 * Titel = Dateiname, Dokumentdatum = heute. Die Voreinstellung gilt je Benutzer und Browser.
 */
interface Ergebnis { id: number | null; text: string; state: 'Positive' | 'Critical' | 'Negative' }
interface Protokoll { name: string; text: string; state: 'Information' | 'Positive' | 'Critical' | 'Negative' }

const ohneEndung = (n: string) => n.replace(/\.[^.]+$/, '');
const endung = (n: string) => (/\.([a-z0-9]+)$/i.exec(n)?.[1] ?? '').toLowerCase();

export function Ablage({ collapsed }: { collapsed: boolean }) {
  const { me } = useSession();
  const [stamm, setStamm] = useState<Stamm | null>(null);
  const [vorgabe, setVorgabe] = useState<Vorgabe | null>(() => vorgabeLesen(me.user.id));
  const [einstellen, setEinstellen] = useState(false);
  const [wartend, setWartend] = useState<File[]>([]);
  const [ueber, setUeber] = useState(false);
  const [lauf, setLauf] = useState<{ fertig: number; gesamt: number } | null>(null);
  const [protokoll, setProtokoll] = useState<Protokoll[]>([]);
  const [zeigeProtokoll, setZeigeProtokoll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { seitenZiel, ablegen } = useAblage();

  const stammLaden = async () => {
    if (stamm) return stamm;
    const s = await api.get<Stamm>(`${UP}/stamm`);
    setStamm(s);
    return s;
  };

  const zusammenfassung = vorgabeText(vorgabe, stamm);
  // Voreinstellung kann auch im Dokumenten-Upload geändert werden (gleicher Speicher)
  useEffect(() => {
    const neu = () => setVorgabe(vorgabeLesen(me.user.id));
    window.addEventListener('tco-ablage-vorgabe', neu);
    return () => window.removeEventListener('tco-ablage-vorgabe', neu);
  }, [me.user.id]);
  useEffect(() => { if (vorgabe && !stamm) stammLaden().catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function uebertragen(files: File[], v: Vorgabe) {
    if (!files.length) return;
    let s: Stamm;
    try { s = await stammLaden(); } catch (e) { toast((e as Error).message, 6000); return; }
    if (!s.paperless) { toast('Paperless ist nicht eingerichtet (Stammdaten → Anbindungen).', 6000); return; }
    setLauf({ fertig: 0, gesamt: files.length });
    let ok = 0;
    const neu: Protokoll[] = [];
    for (const [i, f] of files.entries()) {
      const e = endung(f.name);
      let p: Protokoll;
      if (!s.dateitypen.includes(e)) p = { name: f.name, text: `Dateityp „${e || '?'}“ nicht erlaubt`, state: 'Negative' };
      else if (f.size > 50 * 1024 * 1024) p = { name: f.name, text: 'größer als 50 MB', state: 'Negative' };
      else {
        try {
          const r = await api.post<Ergebnis>(`${UP}/datei`, {
            datei: f.name, inhalt: await dateiLesen(f), meta: { titel: ohneEndung(f.name), datum: s.heute, ...metaFuerUpload(v) },
          });
          p = { name: f.name, text: r.text, state: r.state };
          if (r.state !== 'Negative') ok++;
        } catch (x) {
          p = { name: f.name, text: (x as Error).message, state: 'Negative' };
        }
      }
      neu.push(p);
      setLauf({ fertig: i + 1, gesamt: files.length });
    }
    setLauf(null);
    // neu angelegte Korrespondenten/Tags erscheinen danach in den Auswahllisten
    if (v.korrespondentNeu.trim() || v.tagsNeu.trim()) setStamm(null);
    setProtokoll((alt) => [...neu.reverse(), ...alt].slice(0, 30));
    const fehler = files.length - ok;
    return `${ok} von ${files.length} Datei(en) in Paperless abgelegt${fehler ? ` – ${fehler} fehlgeschlagen (Details unter „Fehler“ im Ablagefeld)` : ''}`;
  }

  /** Dateien mit der Voreinstellung ablegen: ohne Voreinstellung erst einstellen, dann übertragen */
  const mitVorgabe = async (files: File[]) => {
    if (!files.length || lauf) return;
    if (!vorgabe) { setWartend(files); setEinstellen(true); stammLaden().catch((e) => toast((e as Error).message, 6000)); return; }
    return uebertragen(files, vorgabe);
  };
  // Ersatzziel für Strg+V und Ablagen auf Seiten ohne eigenes Ziel
  useAblageZiel({ titel: 'Paperless (Voreinstellung)', annehmen: mitVorgabe }, true);
  /** Feld in der Navigation: auf Seiten mit Objekt dorthin, sonst mit Voreinstellung */
  const annehmen = (files: File[]) => (seitenZiel ? ablegen(files, seitenZiel) : ablegen(files));

  const dnd = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setUeber(true); } },
    onDragLeave: () => setUeber(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setUeber(false); annehmen(Array.from(e.dataTransfer.files)); },
  };
  const fehler = protokoll.filter((p) => p.state === 'Negative').length;

  return (
    <>
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { annehmen(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <div className={`portal-ablage${ueber ? ' portal-ablage--ueber' : ''}${collapsed ? ' portal-ablage--klein' : ''}${lauf ? ' portal-ablage--lauf' : ''}`}
           role="button" tabIndex={0} title={collapsed ? `Dateien ablegen – ${seitenZiel ? seitenZiel.titel : zusammenfassung}` : undefined}
           aria-label="Dateien nach Paperless ablegen: hierher ziehen oder auswählen"
           onClick={() => !lauf && fileRef.current?.click()}
           onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !lauf) { e.preventDefault(); fileRef.current?.click(); } }}
           {...dnd}>
        {collapsed || lauf ? (
          <>
            {lauf
              ? <BusyIndicator active size="S" />
              : <Icon name={ueber ? 'download' : 'upload-to-cloud'} className="portal-ablage__icon" />}
            {!collapsed && (
              <div className="portal-ablage__text">
                <span className="portal-ablage__titel">{`Übertrage ${lauf!.fertig + 1 > lauf!.gesamt ? lauf!.gesamt : lauf!.fertig + 1} von ${lauf!.gesamt} …`}</span>
                <span className="portal-ablage__info">{seitenZiel ? `→ ${seitenZiel.titel}` : zusammenfassung}</span>
              </div>
            )}
          </>
        ) : (
          // Illustrated Message wie die Ablagefelder auf den Seiten (klein, passend zur Navigation)
          <IllustratedMessage name="DragFilesToUpload" design="Dot" className="portal-ablage__illu"
                              titleText={ueber ? 'Loslassen zum Ablegen' : 'Dateien hier ablegen'}
                              subtitleText={seitenZiel ? `→ ${seitenZiel.titel}` : zusammenfassung} />
        )}
      </div>
      {!collapsed && (
        <div className="portal-ablage__leiste">
          <Button design="Transparent" icon="action-settings" onClick={() => { setEinstellen(true); stammLaden().catch((e) => toast((e as Error).message, 6000)); }}>
            Voreinstellung
          </Button>
          {protokoll.length > 0 && (
            <Button design="Transparent" icon={fehler ? 'message-error' : 'history'} onClick={() => setZeigeProtokoll(true)}>
              {fehler ? `${fehler} Fehler` : 'Verlauf'}
            </Button>
          )}
        </div>
      )}

      {einstellen && (
        <VorgabeDialog stamm={stamm} vorgabe={vorgabe ?? LEER} wartend={wartend.length}
                       onClose={() => { setEinstellen(false); setWartend([]); }}
                       onSpeichern={(v) => {
                         setVorgabe(v); vorgabeSpeichern(me.user.id, v); setEinstellen(false);
                         const f = wartend; setWartend([]);
                         if (f.length) uebertragen(f, v).then((t) => t && toast(t, 6000)); else toast('Voreinstellung gespeichert');
                       }} />
      )}
      {zeigeProtokoll && createPortal(
        <Dialog open headerText="Zuletzt abgelegte Dateien" style={{ width: 'min(32rem, 96vw)' }} onClose={() => setZeigeProtokoll(false)}
                footer={<Bar endContent={<>
                  <Button design="Transparent" onClick={() => { setProtokoll([]); setZeigeProtokoll(false); }}>Leeren</Button>
                  <Button onClick={() => setZeigeProtokoll(false)}>Schließen</Button>
                </>} />}>
          <div className="portal-ablage__protokoll">
            {protokoll.map((p, i) => (
              <div key={i} className={`portal-ablage__zeile portal-ablage__zeile--${p.state}`}>
                <Icon name={p.state === 'Positive' ? 'accept' : p.state === 'Negative' ? 'error' : 'pending'} />
                <div><b>{p.name}</b><br /><span>{p.text}</span></div>
              </div>
            ))}
          </div>
        </Dialog>,
        document.body,
      )}
    </>
  );
}

function VorgabeDialog({ stamm, vorgabe, wartend, onClose, onSpeichern }: {
  stamm: Stamm | null; vorgabe: Vorgabe; wartend: number; onClose: () => void; onSpeichern: (v: Vorgabe) => void;
}) {
  const [v, setV] = useState<Vorgabe>(vorgabe);
  const navigate = useNavigate();
  return createPortal(
    <Dialog open headerText="Ablagefeld – Voreinstellung" style={{ width: 'min(30rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<>
              <Button design="Emphasized" disabled={!stamm?.paperless || !v.doktyp} onClick={() => onSpeichern(v)}>
                {wartend ? `Speichern und ${wartend} Datei(en) ablegen` : 'Speichern'}
              </Button>
              <Button onClick={onClose}>Abbrechen</Button>
            </>} />}>
      {!stamm && <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />}
      {stamm && !stamm.paperless && <MessageStrip design="Critical" hideCloseButton>Paperless ist nicht eingerichtet (Stammdaten → Anbindungen).</MessageStrip>}
      {stamm?.paperless && (
        <div className="portal-ablage__form">
          {wartend > 0 && <MessageStrip design="Information" hideCloseButton>Bitte zuerst festlegen, wie die {wartend} Datei(en) abgelegt werden sollen.</MessageStrip>}
          <MetaFelder stamm={stamm} v={v} onChange={setV} pflichtDoktyp kompakt />
          <Text className="portal-muted portal-small">
            Titel = Dateiname, Dokumentdatum = heute. Die Voreinstellung gilt für Ihren Benutzer in diesem Browser und wird auch im Dokumenten-Upload verwendet.
            Für abweichende Angaben je Datei: <Link onClick={() => { onClose(); navigate('/tco/upload'); }}>Finanzen → Dokumenten-Upload</Link>.
          </Text>
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
