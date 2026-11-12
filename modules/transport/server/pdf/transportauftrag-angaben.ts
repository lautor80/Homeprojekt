/**
 * Angaben des Transportauftrags an den Unternehmer (#170) – ohne PDF-Bibliothek, damit testbar:
 * - Infoblock: Auftrags-Nr. mit dem Hinweis, sie auf der Rechnung anzugeben, und Datum (Kennzeichen und Ladenummer entfallen;
 *   die Ladenummer je Beladestelle steht weiter beim Stop),
 * - Frachtpreis: der Preis des Unternehmers (Frachtpreis VK) – Frachtpreis EK ist der Preis des Kunden und geht in die Rechnung.
 */
export const RECHNUNGSHINWEIS = 'Bitte immer auf der Rechnung angeben';

export function transportauftragAngaben(a: { auftragsnr: string; frachtpreis_vk: number }, datum: string): { info: [string, string][]; frachtpreis: number } {
  return {
    info: [['Auftrags-Nr.', a.auftragsnr], ['', RECHNUNGSHINWEIS], ['Datum', datum]],
    frachtpreis: a.frachtpreis_vk,
  };
}
