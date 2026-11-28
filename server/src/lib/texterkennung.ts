/**
 * Texterkennung (#158): Text aus Bildern (Screenshot, Foto) mit tesseract und aus PDFs mit pdftotext lesen (gescannte PDFs:
 * Seiten mit pdftoppm rendern, dann tesseract).
 * Beide Programme laufen lokal im Container (Dockerfile: tesseract-ocr, tesseract-ocr-deu, poppler-utils) – es werden
 * keine Daten an fremde Dienste gegeben. Die Dateien liegen nur für den Aufruf in einem eigenen temporären Ordner.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessError } from '../errors.js';

function aufruf(programm: string, args: string[], timeout: number): Promise<string> {
  return new Promise((ok, fehler) => {
    execFile(programm, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '2' } }, (e, stdout, stderr) => {
      if (e) fehler(Object.assign(e, { stderr: String(stderr ?? '') }));
      else ok(String(stdout));
    });
  });
}
async function mitDatei<T>(name: string, inhalt: Buffer, fn: (pfad: string) => Promise<T>): Promise<T> {
  const ordner = await mkdtemp(join(tmpdir(), 'portal-text-'));
  try {
    const pfad = join(ordner, name);
    await writeFile(pfad, inhalt, { mode: 0o600 });
    return await fn(pfad);
  } finally {
    await rm(ordner, { recursive: true, force: true }).catch(() => undefined);
  }
}
const fehlt = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** PNG oder JPEG an den ersten Bytes erkennen (nur diese beiden werden gelesen) */
export function bildart(b: Buffer): 'png' | 'jpg' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  return null;
}

/**
 * Text eines Bildes lesen. Kleine Schrift (Screenshot) vorher vergrößern – das macht der Aufrufer (Browser, etwa dreifach).
 * Seitenaufteilung automatisch (Spalten bleiben getrennt), Wortabstände bleiben erhalten.
 */
export async function bildText(bild: Buffer, sprachen = 'deu+eng'): Promise<string> {
  const art = bildart(bild);
  if (!art) throw new BusinessError('Das Bild kann nicht gelesen werden – bitte als PNG oder JPEG einfügen.');
  return mitDatei(`bild.${art}`, bild, async (pfad) => {
    const lesen = (l: string) => aufruf('tesseract', [pfad, 'stdout', '-l', l, '--psm', '3', '-c', 'preserve_interword_spaces=1'], 45_000);
    try {
      return await lesen(sprachen);
    } catch (e) {
      if (fehlt(e)) throw new BusinessError('Die Texterkennung ist auf dem Server nicht installiert (tesseract fehlt) – bitte den Text kopieren und einfügen.');
      // Sprachdaten fehlen: mit Englisch allein versuchen
      if (/Failed loading language|Error opening data file/i.test((e as { stderr?: string }).stderr ?? '') && sprachen !== 'eng') return lesen('eng');
      throw new BusinessError('Das Bild konnte nicht gelesen werden – bitte einen schärferen Ausschnitt oder den Text einfügen.');
    }
  });
}

/** Text eines PDFs (Textebene, erste Seiten). Gescannte PDFs ohne Text liefern eine leere Zeichenkette. */
export async function pdfText(pdf: Buffer, seiten = 3): Promise<string> {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BusinessError('Die Datei ist kein PDF.');
  return mitDatei('datei.pdf', pdf, async (pfad) => {
    try {
      return await aufruf('pdftotext', ['-layout', '-l', String(seiten), '-enc', 'UTF-8', pfad, '-'], 30_000);
    } catch (e) {
      if (fehlt(e)) throw new BusinessError('PDFs können auf dem Server nicht gelesen werden (pdftotext fehlt) – bitte den Text kopieren und einfügen.');
      throw new BusinessError('Das PDF konnte nicht gelesen werden – bitte den Text kopieren und einfügen.');
    }
  });
}

/**
 * Gescanntes PDF ohne Textebene: die ersten Seiten mit pdftoppm (poppler-utils) als PNG rendern (200 dpi) und mit tesseract
 * lesen. Fehlt eines der Programme, kommt eine leere Zeichenkette zurück – der Aufrufer meldet „kein Text erkannt“.
 */
export async function pdfScanText(pdf: Buffer, seiten = 3, sprachen = 'deu+eng'): Promise<string> {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BusinessError('Die Datei ist kein PDF.');
  return mitDatei('scan.pdf', pdf, async (pfad) => {
    const ordner = pfad.slice(0, pfad.lastIndexOf('/'));
    try {
      await aufruf('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', String(seiten), pfad, join(ordner, 'seite')], 60_000);
    } catch (e) {
      if (fehlt(e)) return '';
      throw new BusinessError('Das gescannte PDF konnte nicht gelesen werden.');
    }
    const bilder = (await readdir(ordner)).filter((n) => /^seite-?\d+\.png$/.test(n)).sort();
    const teile: string[] = [];
    for (const b of bilder) {
      const lesen = (l: string) => aufruf('tesseract', [join(ordner, b), 'stdout', '-l', l, '--psm', '3', '-c', 'preserve_interword_spaces=1'], 45_000);
      try {
        teile.push(await lesen(sprachen));
      } catch (e) {
        if (fehlt(e)) return '';
        if (/Failed loading language|Error opening data file/i.test((e as { stderr?: string }).stderr ?? '') && sprachen !== 'eng') teile.push(await lesen('eng'));
        else throw new BusinessError(`Seite ${teile.length + 1} des gescannten PDFs konnte nicht gelesen werden.`);
      }
    }
    return teile.join('\n');
  });
}

// ---------------------------------------------------------------- seitenweise lesen und PDFs zerlegen (Euroflex Eingangsrechnungen)

const istPdfInhalt = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-';

/** Seitenzahl eines PDFs (pdfinfo); 0, wenn sie sich nicht bestimmen lässt (Programm fehlt, PDF defekt oder verschlüsselt) */
export async function pdfSeitenzahl(pdf: Buffer): Promise<number> {
  if (!istPdfInhalt(pdf)) return 0;
  return mitDatei('datei.pdf', pdf, async (pfad) => {
    try {
      const m = /^Pages:\s+(\d+)/m.exec(await aufruf('pdfinfo', [pfad], 20_000));
      return m ? Number(m[1]) : 0;
    } catch {
      return 0;
    }
  });
}

/**
 * Text je Seite (höchstens `max` Seiten): Textebene mit pdftotext; Seiten ohne Text (Scan) werden einzeln gerendert und mit
 * tesseract gelesen – höchstens `maxScan` Seiten, die übrigen bleiben leer. Liefert null, wenn das PDF nicht lesbar ist oder
 * mehr als `max` Seiten hat (dann wird nicht seitenweise gearbeitet).
 */
export async function pdfSeitenTexte(pdf: Buffer, max = 40, maxScan = 12, sprachen = 'deu+eng'): Promise<{ seiten: string[]; gescannt: number } | null> {
  if (!istPdfInhalt(pdf)) return null;
  return mitDatei('datei.pdf', pdf, async (pfad) => {
    const ordner = pfad.slice(0, pfad.lastIndexOf('/'));
    let anzahl: number;
    let roh: string;
    try {
      const m = /^Pages:\s+(\d+)/m.exec(await aufruf('pdfinfo', [pfad], 20_000));
      anzahl = m ? Number(m[1]) : 0;
      if (!anzahl || anzahl > max) return null;
      roh = await aufruf('pdftotext', ['-layout', '-enc', 'UTF-8', pfad, '-'], 60_000);
    } catch {
      return null;
    }
    // pdftotext trennt die Seiten mit Seitenvorschub (auch nach der letzten)
    const teile = roh.split('\f');
    const seiten = Array.from({ length: anzahl }, (_, i) => (teile[i] ?? '').trim());
    let gescannt = 0;
    for (let i = 0; i < anzahl && gescannt < maxScan; i++) {
      if (seiten[i]) continue;
      const nr = String(i + 1);
      const basis = join(ordner, `s${nr}`);
      try {
        await aufruf('pdftoppm', ['-r', '200', '-png', '-f', nr, '-l', nr, '-singlefile', pfad, basis], 60_000);
        const lesen = (l: string) => aufruf('tesseract', [`${basis}.png`, 'stdout', '-l', l, '--psm', '3', '-c', 'preserve_interword_spaces=1'], 45_000);
        try {
          seiten[i] = (await lesen(sprachen)).trim();
        } catch (e) {
          if (/Failed loading language|Error opening data file/i.test((e as { stderr?: string }).stderr ?? '') && sprachen !== 'eng') seiten[i] = (await lesen('eng')).trim();
          else throw e;
        }
        gescannt++;
      } catch (e) {
        // Texterkennung fehlt oder die Seite ist nicht lesbar: Seite bleibt leer
        if (fehlt(e)) break;
      } finally {
        await rm(`${basis}.png`, { force: true }).catch(() => undefined);
      }
    }
    return { seiten, gescannt };
  });
}

/**
 * Neues PDF aus den genannten Seiten (ab 1, in dieser Reihenfolge) – pdfseparate/pdfunite aus poppler-utils. Die Seiten werden
 * unverändert übernommen (kein Neurendern). Wirft, wenn die Programme fehlen oder das PDF sich nicht zerlegen lässt.
 */
export async function pdfSeitenAuswahl(pdf: Buffer, seiten: number[]): Promise<Buffer> {
  if (!istPdfInhalt(pdf)) throw new BusinessError('Die Datei ist kein PDF.');
  if (!seiten.length) throw new BusinessError('Keine Seiten gewählt.');
  return mitDatei('datei.pdf', pdf, async (pfad) => {
    const ordner = pfad.slice(0, pfad.lastIndexOf('/'));
    try {
      const von = Math.min(...seiten), bis = Math.max(...seiten);
      await aufruf('pdfseparate', ['-f', String(von), '-l', String(bis), pfad, join(ordner, 'p-%d.pdf')], 60_000);
      const dateien = seiten.map((s) => join(ordner, `p-${s}.pdf`));
      if (dateien.length === 1) return await readFile(dateien[0]);
      const ziel = join(ordner, 'teil.pdf');
      await aufruf('pdfunite', [...dateien, ziel], 60_000);
      return await readFile(ziel);
    } catch (e) {
      if (fehlt(e)) throw new BusinessError('PDFs können auf dem Server nicht zerlegt werden (poppler-utils fehlt).');
      throw new BusinessError('Das PDF lässt sich nicht zerlegen (defekt oder geschützt).');
    }
  });
}

/** E-Rechnung im PDF (ZUGFeRD/Factur-X/XRechnung als eingebettete XML)? Solche PDFs werden nie zerlegt. */
export async function pdfHatERechnung(pdf: Buffer): Promise<boolean> {
  if (!istPdfInhalt(pdf)) return false;
  const muster = /factur-x|zugferd|xrechnung/i;
  if (muster.test(pdf.toString('latin1'))) return true;
  return mitDatei('datei.pdf', pdf, async (pfad) => {
    try { return muster.test(await aufruf('pdfdetach', ['-list', pfad], 20_000)); } catch { return false; }
  });
}
