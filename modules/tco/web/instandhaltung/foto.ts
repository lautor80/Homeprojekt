/**
 * Fotos für Schadensmeldungen im Browser verkleinern (längste Kante 1600 px, JPEG) – spart Speicher und mobiles Datenvolumen.
 */
export interface Foto { name: string; data: string }

const MAX = 1600;

export function fotoVerkleinern(f: File): Promise<Foto> {
  return new Promise((ok, err) => {
    if (!f.type.startsWith('image/')) { err(new Error(`„${f.name}“ ist kein Foto.`)); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const faktor = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * faktor));
      c.height = Math.max(1, Math.round(img.naturalHeight * faktor));
      const ctx = c.getContext('2d');
      if (!ctx) { err(new Error('Das Foto konnte nicht verarbeitet werden.')); return; }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      ok({ name: f.name.replace(/\.[^.]+$/, '') + '.jpg', data: c.toDataURL('image/jpeg', 0.8) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); err(new Error(`„${f.name}“ konnte nicht gelesen werden (Format nicht unterstützt?).`)); };
    img.src = url;
  });
}

export const FOTO_URL = (id: number) => `/api/m/tco/schaden/foto/${id}`;

export const STATUS_STATE: Record<string, 'Critical' | 'Information' | 'Positive' | 'Negative' | 'None'> = {
  NEU: 'Critical', GESICHTET: 'Information', ZUGEWIESEN: 'Information', IN_ARBEIT: 'Information', WARTET: 'Critical',
  ERLEDIGT: 'Positive', ABGELEHNT: 'None', DUPLIKAT: 'None',
};
export const AUSWIRKUNG_STATE: Record<string, 'Negative' | 'Critical' | 'Information' | 'None'> = {
  SICHERHEIT: 'Negative', UNBESPIELBAR: 'Critical', EINGESCHRAENKT: 'Information', OPTISCH: 'None',
};
export const zeitpunkt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
