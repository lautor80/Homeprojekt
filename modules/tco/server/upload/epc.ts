/**
 * EPC-QR-Code („GiroCode“) für eine SEPA-Überweisung – reiner Aufbau des Inhalts, ohne Datenbank und ohne Bilderzeugung.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import { ibanGueltig, normalisieren } from '../../../../server/src/lib/sepa.js';

const condense = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface Zahlung { empfaenger: string; iban: string; bic: string; betrag: number | null; zweck: string }

/** nur Zeichen, die jede Banking-App im Namen und Verwendungszweck annimmt; Zeilenumbrüche würden den Aufbau zerstören */
export const feldText = (s: string, max: number) => condense(s.replace(/[\r\n]+/g, ' ')).slice(0, max);

/**
 * Inhalt des EPC-QR-Codes (European Payments Council, „Quick Response Code: Guidelines to enable data capture for the
 * initiation of a SEPA credit transfer“), Version 002, UTF-8: BCD / 002 / 1 / SCT / BIC / Name / IBAN / EUR-Betrag /
 * Zweckcode / Referenz / Verwendungszweck. Der BIC ist ab Version 002 freiwillig, der Betrag darf fehlen.
 */
export function epcText(z: Zahlung): string {
  const iban = normalisieren(z.iban);
  if (!ibanGueltig(iban)) throw new BusinessError('Die IBAN des Empfängers ist ungültig.');
  const name = feldText(z.empfaenger, 70);
  if (!name) throw new BusinessError('Der Name des Empfängers fehlt.');
  if (z.betrag != null && !(z.betrag >= 0.01 && z.betrag <= 999_999_999.99)) throw new BusinessError('Der Betrag muss zwischen 0,01 und 999.999.999,99 Euro liegen.');
  const zeilen = ['BCD', '002', '1', 'SCT', normalisieren(z.bic), name, iban, z.betrag != null ? `EUR${z.betrag.toFixed(2)}` : '', '', '', feldText(z.zweck, 140)];
  // leere Zeilen am Ende entfallen
  while (zeilen[zeilen.length - 1] === '') zeilen.pop();
  return zeilen.join('\n');
}

