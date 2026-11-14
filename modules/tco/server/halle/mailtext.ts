/**
 * Text der Rechnungsmail der Tennishalle: Hat der Verein unter Einstellungen → E-Mail-Texte einen eigenen Text
 * festgelegt (#232), gilt er – für eine und für mehrere Rechnungen. Sonst bleibt der Standardtext mit Einzahl/Mehrzahl.
 * (Eigene Datei, damit versand.ts nicht am Verzeichnis der E-Mail-Texte hängt – das Verzeichnis liest dort den Standardtext.)
 */
import type { Db, Verein } from '../verein.js';
import { fuellen, mailtextEigen, type MailVorlage } from '../mailtexte.js';
import { mailTexte, rechnungDownload } from './versand.js';

const SCHLUESSEL = 'halle.rechnung';

/** Vorbelegung im Dialog „per E-Mail senden“ */
export async function rechnungMailText(db: Db, v: Verein, vorname: string, rgnrs: string[], link?: string | null): Promise<MailVorlage> {
  const eigen = await mailtextEigen(db, SCHLUESSEL);
  if (!eigen) return mailTexte(v, vorname, rgnrs, link);
  const werte = { Vorname: vorname || 'zusammen', Rechnungsnummer: rgnrs.join(', '), Download: link ? rechnungDownload(link) : '' };
  return { betreff: fuellen(eigen.betreff, werte), text: fuellen(eigen.text, werte) };
}

/**
 * Eigener Text als Vorlage für den Sammelversand: {Vorname} und {Rechnungsnummer} bleiben stehen (je Empfänger ersetzt),
 * der Satz mit dem Link entfällt – im Sammelversand hängt die Rechnung an. null = kein eigener Text.
 */
export async function sammelVorlageEigen(db: Db): Promise<MailVorlage | null> {
  const eigen = await mailtextEigen(db, SCHLUESSEL);
  return eigen ? { betreff: fuellen(eigen.betreff, { Download: '' }), text: fuellen(eigen.text, { Download: '' }) } : null;
}
