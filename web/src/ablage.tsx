import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Bar, Button, BusyIndicator, Dialog, Icon, IllustratedMessage } from '@ui5/webcomponents-react';
import '@ui5/webcomponents-fiori/dist/illustrations/DragFilesToUpload.js';
import { toast } from './toast';
import { einfuegenAblegen, imEingabefeld } from './ablage-regel';

/**
 * Ablage von Dateien zum gerade geöffneten Objekt (Buchung, Mitglied, Auftrag …).
 *
 *  - Seiten melden ihr Ziel mit useAblageZiel() an; das zuletzt angemeldete gilt (Dialoge vor Seiten).
 *  - Ohne Seitenziel gilt das Ersatzziel (z. B. das Ablagefeld der Navigation mit Voreinstellung).
 *  - Strg+V mit Bild/Datei in der Zwischenablage (Screenshot) legt beim aktuellen Ziel ab – nicht aber, wenn Text in ein
 *    Eingabefeld eingefügt wird (aus Excel kopierte Zellen bringen neben dem Text ein Bild mit).
 *  - <AblageFlaeche> ist eine Fläche zum Hineinziehen/Auswählen für ein bestimmtes Ziel.
 *  - Nach dem Ablegen erscheint eine Meldung mit dem Ziel und – falls möglich – „Rückgängig“.
 */
export interface AblageErgebnis { text: string; rueckgaengig?: () => Promise<unknown> }
export interface AblageZiel {
  /** z. B. „Buchung 0000001234“ oder „Auftrag 2026_0153“ */
  titel: string;
  /** Dateien übernehmen; Rückgabe = Meldung (optional mit Rückgängig) oder nichts (Ziel meldet selbst) */
  annehmen: (files: File[]) => Promise<AblageErgebnis | string | void> | AblageErgebnis | string | void;
}

interface Eintrag { id: number; ziel: () => AblageZiel | null }
interface Ctx {
  /** aktuelles Ziel (Seite/Dialog), sonst Ersatzziel */
  ziel: AblageZiel | null;
  seitenZiel: AblageZiel | null;
  laeuft: boolean;
  ablegen: (files: File[], ziel?: AblageZiel | null) => Promise<void>;
  anmelden: (e: Eintrag, ersatz: boolean) => () => void;
}
const AblageCtx = createContext<Ctx | null>(null);

/** Bildschirmfotos aus der Zwischenablage heißen „image.png“ – sprechend umbenennen */
function screenshotName(f: File, i: number): File {
  if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const name = `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}${i ? `-${i + 1}` : ''}.${ext}`;
  return new File([f], name, { type: f.type || 'image/png', lastModified: d.getTime() });
}

export function AblageProvider({ children }: { children: ReactNode }) {
  const seiten = useRef<Eintrag[]>([]);
  const ersatz = useRef<Eintrag[]>([]);
  const [, neu] = useState(0);
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState<(AblageErgebnis & { fehler?: boolean }) | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const anmelden = useCallback((e: Eintrag, istErsatz: boolean) => {
    const l = istErsatz ? ersatz : seiten;
    l.current = [...l.current, e];
    neu((n) => n + 1);
    return () => { l.current = l.current.filter((x) => x.id !== e.id); neu((n) => n + 1); };
  }, []);

  const aktuell = (l: Eintrag[]) => { for (let i = l.length - 1; i >= 0; i--) { const z = l[i].ziel(); if (z) return z; } return null; };
  const seitenZiel = aktuell(seiten.current);
  const ziel = seitenZiel ?? aktuell(ersatz.current);

  const zeigen = (m: AblageErgebnis & { fehler?: boolean }) => {
    window.clearTimeout(timer.current);
    setMeldung(m);
    timer.current = window.setTimeout(() => setMeldung(null), m.rueckgaengig ? 10_000 : 6_000);
  };

  const ablegen = useCallback(async (files: File[], z?: AblageZiel | null) => {
    const t = z ?? aktuell(seiten.current) ?? aktuell(ersatz.current);
    if (!files.length) return;
    if (!t) { toast('Hier ist keine Ablage möglich – bitte ein Objekt öffnen (z. B. Buchung, Mitglied, Auftrag).', 5000); return; }
    setLaeuft(true);
    try {
      const r = await t.annehmen(files);
      if (typeof r === 'string') zeigen({ text: r });
      else if (r) zeigen(r);
    } catch (e) {
      zeigen({ text: `Ablage bei ${t.titel} fehlgeschlagen: ${(e as Error).message}`, fehler: true });
    } finally {
      setLaeuft(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Strg+V: Bilder/Dateien aus der Zwischenablage (z. B. Screenshot) beim aktuellen Ziel ablegen
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const imFeld = imEingabefeld(e.composedPath().filter((x): x is HTMLElement => x instanceof HTMLElement));
      if (!einfuegenAblegen(files.length, e.clipboardData?.getData('text/plain') ?? '', imFeld)) return;
      if (!aktuell(seiten.current) && !aktuell(ersatz.current)) return;
      e.preventDefault();
      ablegen(files.map(screenshotName));
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [ablegen]);

  const wert = useMemo<Ctx>(() => ({ ziel, seitenZiel, laeuft, ablegen, anmelden }), [ziel, seitenZiel, laeuft, ablegen, anmelden]);
  return (
    <AblageCtx.Provider value={wert}>
      {children}
      {(meldung || laeuft) && (
        <div className={`portal-ablage-meldung${meldung?.fehler ? ' portal-ablage-meldung--fehler' : ''}`} role="status">
          {laeuft ? <BusyIndicator active size="S" /> : <Icon name={meldung?.fehler ? 'error' : 'accept'} />}
          <span>{laeuft ? `Wird abgelegt${ziel ? ` bei ${ziel.titel}` : ''} …` : meldung?.text}</span>
          {!laeuft && meldung?.rueckgaengig && (
            <Button design="Transparent" icon="undo" onClick={async () => {
              const r = meldung.rueckgaengig!;
              setMeldung(null);
              try { await r(); toast('Rückgängig gemacht'); } catch (e) { toast((e as Error).message, 6000); }
            }}>Rückgängig</Button>
          )}
          {!laeuft && <Button design="Transparent" icon="decline" tooltip="Schließen" onClick={() => setMeldung(null)} />}
        </div>
      )}
    </AblageCtx.Provider>
  );
}

export function useAblage(): Ctx {
  const c = useContext(AblageCtx);
  if (!c) throw new Error('AblageProvider fehlt');
  return c;
}

let zaehler = 1;
/** Ziel für Ablage und Strg+V anmelden, solange die Komponente sichtbar ist (null = keins) */
export function useAblageZiel(ziel: AblageZiel | null, ersatz = false) {
  const { anmelden } = useAblage();
  const ref = useRef(ziel);
  ref.current = ziel;
  const aktiv = !!ziel;
  const titel = ziel?.titel;
  useEffect(() => {
    if (!aktiv) return;
    return anmelden({ id: zaehler++, ziel: () => ref.current }, ersatz);
  }, [aktiv, titel, ersatz, anmelden]);
}

/** Dateien aus einem Drop-Ereignis */
export const dropDateien = (e: DragEvent) => Array.from(e.dataTransfer?.files ?? []);
const hatDateien = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** passt die Datei zu einem accept-Ausdruck („.pdf,.csv,image/*,application/zip“)? */
export function dateiPasst(f: File, accept?: string): boolean {
  if (!accept?.trim()) return true;
  const name = f.name.toLowerCase();
  const typ = (f.type || '').toLowerCase();
  return accept.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((a) =>
    a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? typ.startsWith(a.slice(0, -1)) : typ === a);
}

export type AblageGroesse = 'Scene' | 'Spot' | 'Dialog' | 'Dot';

/**
 * Fläche zum Hineinziehen bzw. Auswählen von Dateien für ein bestimmtes Ziel.
 *  - ohne children: Ablagefeld als Illustrated Message („DragFilesToUpload“) – klicken öffnet die Dateiauswahl
 *    (kompakt: schmale Leiste mit Symbol, z. B. in der Navigation)
 *  - mit children: der Inhalt selbst wird zur Ablagefläche (Hervorhebung beim Darüberziehen)
 *  - accept/multiple wie beim Datei-Input; unpassende Dateien werden mit Hinweis übergangen
 */
export function AblageFlaeche({ ziel, text, titel, children, kompakt, deaktiviert, accept, multiple = true, groesse = 'Spot' }: {
  ziel: AblageZiel; text?: string; titel?: string; children?: ReactNode; kompakt?: boolean; deaktiviert?: boolean;
  accept?: string; multiple?: boolean; groesse?: AblageGroesse;
}) {
  const { ablegen, laeuft } = useAblage();
  const [ueber, setUeber] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tiefe = useRef(0);
  const uebergeben = (alle: File[]) => {
    let files = alle.filter((f) => dateiPasst(f, accept));
    if (files.length < alle.length) toast(`${alle.length - files.length} Datei(en) übergangen – erlaubt: ${accept}`, 5000);
    if (!multiple && files.length > 1) { toast('Bitte nur eine Datei ablegen – die erste wird übernommen.', 4000); files = files.slice(0, 1); }
    if (files.length) ablegen(files, ziel);
  };
  const props = deaktiviert ? {} : {
    onDragEnter: (e: DragEvent) => { if (hatDateien(e)) { e.preventDefault(); tiefe.current++; setUeber(true); } },
    onDragOver: (e: DragEvent) => { if (hatDateien(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: () => { tiefe.current = Math.max(0, tiefe.current - 1); if (!tiefe.current) setUeber(false); },
    onDrop: (e: DragEvent) => {
      if (!hatDateien(e)) return;
      e.preventDefault(); e.stopPropagation(); tiefe.current = 0; setUeber(false);
      uebergeben(dropDateien(e));
    },
  };
  if (children) {
    return <div className={`portal-ablageziel${ueber ? ' portal-ablageziel--ueber' : ''}`} data-ziel={ueber ? `Ablegen bei ${ziel.titel}` : undefined} {...props}>{children}</div>;
  }
  const standardText = `${multiple ? 'Dateien' : 'Datei'} hierher ziehen, klicken zum Auswählen oder Screenshot mit Strg+V einfügen`;
  return (
    <>
      <input ref={input} type="file" multiple={multiple} accept={accept} hidden
             onChange={(e) => { uebergeben(Array.from(e.target.files ?? []) as File[]); e.target.value = ''; }} />
      <div className={`portal-ablagebox${kompakt ? ' portal-ablagebox--kompakt' : ' portal-ablagebox--illu'}${ueber ? ' portal-ablagebox--ueber' : ''}${deaktiviert ? ' portal-ablagebox--aus' : ''}`}
           role="button" tabIndex={deaktiviert ? -1 : 0} aria-label={`Dateien ablegen bei ${ziel.titel}`}
           onClick={() => !deaktiviert && !laeuft && input.current?.click()}
           onKeyDown={(e) => { if (!deaktiviert && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
           {...props}>
        {kompakt ? (
          <>
            <Icon name={ueber ? 'download' : 'upload-to-cloud'} />
            <span>{ueber ? `Loslassen – ablegen bei ${ziel.titel}` : text ?? standardText}</span>
          </>
        ) : (
          <IllustratedMessage name="DragFilesToUpload" design={groesse}
                              titleText={ueber ? `Loslassen – ablegen bei ${ziel.titel}` : titel ?? (multiple ? 'Dateien hier ablegen' : 'Datei hier ablegen')}
                              subtitleText={ueber ? '' : text ?? standardText} />
        )}
      </div>
    </>
  );
}

/** Dialog mit Ablagefeld (z. B. für Importe aus der Kopfzeile): Dateien hineinziehen oder auswählen, danach schließt er sich */
export function AblageDialog({ open, titel, ziel, accept, multiple = true, text, feldTitel, onClose }: {
  open: boolean; titel: string; ziel: AblageZiel; accept?: string; multiple?: boolean; text?: string; feldTitel?: string; onClose: () => void;
}) {
  if (!open) return null;
  const z: AblageZiel = { titel: ziel.titel, annehmen: (f) => { onClose(); return ziel.annehmen(f); } };
  return (
    <Dialog open headerText={titel} style={{ width: 'min(36rem, 96vw)' }} onClose={onClose}
            footer={<Bar endContent={<Button onClick={onClose}>Abbrechen</Button>} />}>
      <AblageFlaeche ziel={z} accept={accept} multiple={multiple} text={text} titel={feldTitel} groesse="Dialog" />
    </Dialog>
  );
}
