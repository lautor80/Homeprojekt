import type { FastifyRequest } from 'fastify';
import { feldschutz, type Feldschutz, type SensitiveFieldDef } from '../../../server/src/schutz.js';
import { BusinessError } from '../../../server/src/errors.js';

/**
 * Bankdaten von Personen (Mitglieder, Zahler, Lastschriftpositionen) sind geschützt:
 * IBAN, BIC und der freie Kontoinhaber-Text werden ohne `tco.bankdaten:display` maskiert.
 * Ändern einer Bankverbindung erfordert `tco.bankdaten:edit`.
 *
 * Nicht geschützt (keine personenbezogenen Daten): die eigenen Vereinskonten (Stammdaten,
 * Gläubigerdaten der Sollstellung, IBAN je FI-Geldkonto) – sie stehen ohnehin auf jeder Rechnung
 * und sind über die jeweiligen Pflegeberechtigungen geschützt.
 */
export const P_BANK = { display: 'tco.bankdaten:display', edit: 'tco.bankdaten:edit' };

export const bankSchutz = (req: FastifyRequest): Feldschutz => feldschutz(req, P_BANK.display);

/** Spalten, die in Änderungsbelegen maskiert werden */
export const BANK_FELDER: SensitiveFieldDef[] = [
  { table: 'tco.mitglieder', fields: { iban1: 'iban', bic1: 'bic', abwkontoinh: 'text' }, permission: P_BANK.display },
  { table: 'tco.soll_pos', fields: { iban: 'iban', bic: 'bic' }, permission: P_BANK.display },
  { table: 'tco.mitgliedsantraege', fields: { iban: 'iban', bic: 'bic', kontoinhaber: 'text' }, permission: P_BANK.display },
];

/**
 * Paperless-Dokumenttypen, die Bankdaten enthalten: Aufnahmeantrag (mit SEPA-Mandat), Mitgliederinformation
 * (druckt die Bankverbindung, siehe mitglieder/pdf.ts) und das SEPA-Lastschriftmandat.
 * Öffnen, Notizen und Freigabelinks nur mit `tco.bankdaten:display`.
 */
export const DOKTYPEN_MIT_BANKDATEN = ['Aufnahmeantrag', 'Mitgliederinformation', 'SEPA-Lastschriftmandat', 'SEPA-Mandat', 'Lastschriftmandat'];
export const doktypMitBankdaten = (name: string | null | undefined) =>
  DOKTYPEN_MIT_BANKDATEN.some((t) => t.toLowerCase() === (name ?? '').trim().toLowerCase());

export function bankdatenErforderlich(s: Feldschutz, was: string): void {
  if (!s.klar) throw new BusinessError(`${was} enthält Bankdaten – dafür ist die Berechtigung „Bankdaten im Klartext anzeigen“ nötig.`, 403);
}
