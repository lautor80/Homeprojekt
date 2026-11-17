/**
 * Texterkennung (#158): Text aus Bildern (Screenshot, Foto) mit tesseract und aus PDFs mit pdftotext lesen (gescannte PDFs:
 * Seiten mit pdftoppm rendern, dann tesseract).
 * Beide Programme laufen lokal im Container (Dockerfile: tesseract-ocr, tesseract-ocr-deu, poppler-utils) – es werden
 * keine Daten an fremde Dienste gegeben. Die Dateien liegen nur für den Aufruf in einem eigenen temporären Ordner.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
