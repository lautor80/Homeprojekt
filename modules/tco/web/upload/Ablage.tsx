import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar, BusyIndicator, Button, Dialog, Icon, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, Text,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { useSession } from '@core/session';
import { useAblage, useAblageZiel } from '@core/ablage';
import { toast } from '@core/toast';
import { dateiLesen } from '../util';
import { UP } from './Upload';
import './ablage.css';

/**
 * Ablagefeld unten in der linken Navigation: Dateien hineinziehen (oder antippen und wählen) –
 * sie werden sofort mit der Voreinstellung (Dokumenttyp, Korrespondent, Tags, Speicherpfad) nach Paperless übertragen.
 * Titel = Dateiname, Dokumentdatum = heute. Die Voreinstellung gilt je Benutzer und Browser.
 */
interface Eintrag { id: number; name: string }
interface Stamm { paperless: boolean; dokumenttypen: Eintrag[]; korrespondenten: Eintrag[]; tags: Eintrag[]; speicherpfade: Eintrag[]; heute: string; dateitypen: string[] }
interface Vorgabe { doktyp: string; korrespondent: string; tags: number[]; speicherpfad: string; notiz: string }
interface Ergebnis { id: number | null; text: string; state: 'Positive' | 'Critical' | 'Negative' }
interface Protokoll { name: string; text: string; state: 'Information' | 'Positive' | 'Critical' | 'Negative' }

const LEER: Vorgabe = { doktyp: '', korrespondent: '', tags: [], speicherpfad: '', notiz: '' };
const schluessel = (userId: string) => `tco.ablage.${userId}`;
function vorgabeLesen(userId: string): Vorgabe | null {
  try { const v = localStorage.getItem(schluessel(userId)); return v ? { ...LEER, ...JSON.parse(v) } : null; } catch { return null; }
}
function vorgabeSpeichern(userId: string, v: Vorgabe) {
  try { localStorage.setItem(schluessel(userId), JSON.stringify(v)); } catch { /* Speicher nicht verfügbar – gilt dann nur bis zum Neuladen */ }
}
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

  const name = (l: Eintrag[] | undefined, id: string) => l?.find((x) => String(x.id) === id)?.name;
  const zusammenfassung = vorgabe
    ? [name(stamm?.dokumenttypen, vorgabe.doktyp) ?? (vorgabe.doktyp ? 'Dokumenttyp gewählt' : 'ohne Dokumenttyp'),
       name(stamm?.korrespondenten, vorgabe.korrespondent), vorgabe.tags.length ? `${vorgabe.tags.length} Tag(s)` : null].filter(Boolean).join(' · ')
    : 'Noch nicht voreingestellt';
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
            datei: f.name, inhalt: await dateiLesen(f), meta: {
              titel: ohneEndung(f.name), datum: s.heute, doktyp: v.doktyp ? Number(v.doktyp) : null,
              korrespondent: v.korrespondent ? Number(v.korrespondent) : null, korrespondentNeu: '',
              tags: v.tags, tagsNeu: [], speicherpfad: v.speicherpfad ? Number(v.speicherpfad) : null, notiz: v.notiz,
            },
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
        {lauf
          ? <BusyIndicator active size="S" />
          : <Icon name={ueber ? 'download' : 'upload-to-cloud'} className="portal-ablage__icon" />}
        {!collapsed && (
          <div className="portal-ablage__text">
            <span className="portal-ablage__titel">
              {lauf ? `Übertrage ${lauf.fertig + 1 > lauf.gesamt ? lauf.gesamt : lauf.fertig + 1} von ${lauf.gesamt} …` : ueber ? 'Loslassen zum Ablegen' : 'Dateien hier ablegen'}
            </span>
            <span className="portal-ablage__info">{seitenZiel ? `→ ${seitenZiel.titel}` : zusammenfassung}</span>
          </div>
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
  const auswahl = (label: string, feld: 'doktyp' | 'korrespondent' | 'speicherpfad', liste: Eintrag[] | undefined, leer: string, pflicht = false) => (
    <div className="portal-ablage__feld">
      <Label required={pflicht} showColon>{label}</Label>
      <Select style={{ width: '100%' }} onChange={(e) => setV({ ...v, [feld]: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
        <Option data-k="" selected={!v[feld]}>{leer}</Option>
        {(liste ?? []).map((x) => <Option key={x.id} data-k={String(x.id)} selected={String(x.id) === v[feld]}>{x.name}</Option>)}
      </Select>
    </div>
  );
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
          {auswahl('Dokumenttyp', 'doktyp', stamm.dokumenttypen, '– bitte wählen –', true)}
          {auswahl('Korrespondent', 'korrespondent', stamm.korrespondenten, '– keine Angabe –')}
          <div className="portal-ablage__feld">
            <Label showColon>Tags</Label>
            <MultiComboBox style={{ width: '100%' }} placeholder="keine"
                           onSelectionChange={(e) => setV({ ...v, tags: e.detail.items.map((i) => Number((i as HTMLElement).dataset.id)) })}>
              {stamm.tags.map((t) => <MultiComboBoxItem key={t.id} data-id={t.id} text={t.name} selected={v.tags.includes(t.id)} />)}
            </MultiComboBox>
          </div>
          {auswahl('Speicherpfad', 'speicherpfad', stamm.speicherpfade, '– Standard von Paperless –')}
          <div className="portal-ablage__feld">
            <Label showColon>Notiz (an jedes Dokument)</Label>
            <Input style={{ width: '100%' }} value={v.notiz} maxlength={500} onInput={(e) => setV({ ...v, notiz: e.target.value })} />
          </div>
          <Text className="portal-muted portal-small">
            Titel = Dateiname, Dokumentdatum = heute. Die Voreinstellung gilt für Ihren Benutzer in diesem Browser.
            Für abweichende Angaben je Datei: Finanzen → Dokumenten-Upload.
          </Text>
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
