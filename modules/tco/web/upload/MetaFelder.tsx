import {
  ComboBox, ComboBoxItem, Input, Label, Option, Select, Text,
} from '@ui5/webcomponents-react';

/**
 * Gemeinsame Paperless-Metadaten für Ablagefeld (Navigation) und Dokumenten-Upload:
 * Dokumenttyp, Korrespondent (wählen ODER neuen Namen eintippen – wird beim Ablegen in Paperless angelegt),
 * Tags (wählen und/oder neue eintippen), Speicherpfad, Notiz. Die Voreinstellung wird je Benutzer im Browser gespeichert
 * und von beiden Stellen gemeinsam genutzt.
 */
export interface Eintrag { id: number; name: string }
export interface Stamm {
  paperless: boolean; dokumenttypen: Eintrag[]; korrespondenten: Eintrag[]; tags: Eintrag[]; speicherpfade: Eintrag[]; heute: string; dateitypen: string[];
  /** Custom Field „Folgeaktion“: Auswahlfeld mit festen Werten oder Text mit Vorschlägen */
  folgeaktion?: { feld: string; vorhanden: boolean; auswahl: boolean; optionen: string[] };
}
export interface Vorgabe { doktyp: string; korrespondent: string; korrespondentNeu: string; tags: number[]; tagsNeu: string; speicherpfad: string; notiz: string; folgeaktion: string }

export const LEER: Vorgabe = { doktyp: '', korrespondent: '', korrespondentNeu: '', tags: [], tagsNeu: '', speicherpfad: '', notiz: '', folgeaktion: '' };
const schluessel = (userId: string) => `tco.ablage.${userId}`;
export function vorgabeLesen(userId: string): Vorgabe | null {
  try { const v = localStorage.getItem(schluessel(userId)); return v ? { ...LEER, ...JSON.parse(v) } : null; } catch { return null; }
}
export function vorgabeSpeichern(userId: string, v: Vorgabe) {
  try { localStorage.setItem(schluessel(userId), JSON.stringify(v)); } catch { /* Speicher nicht verfügbar */ }
  window.dispatchEvent(new Event('tco-ablage-vorgabe'));
}

/** Metadaten für den Upload-Aufruf (/upload/datei) */
export function metaFuerUpload(v: Vorgabe) {
  return {
    doktyp: v.doktyp ? Number(v.doktyp) : null,
    korrespondent: v.korrespondent ? Number(v.korrespondent) : null,
    korrespondentNeu: v.korrespondent ? '' : v.korrespondentNeu.trim(),
    // Tags werden beim Upload nie gesetzt (auch nicht aus älteren Voreinstellungen)
    tags: [], tagsNeu: [],
    speicherpfad: v.speicherpfad ? Number(v.speicherpfad) : null, notiz: v.notiz, folgeaktion: v.folgeaktion.trim(),
  };
}

/** Kurzbeschreibung der Voreinstellung (Ablagefeld) */
export function vorgabeText(v: Vorgabe | null, s: Stamm | null): string {
  if (!v) return 'Noch nicht voreingestellt';
  const name = (l: Eintrag[] | undefined, id: string) => l?.find((x) => String(x.id) === id)?.name;
  return [name(s?.dokumenttypen, v.doktyp) ?? (v.doktyp ? 'Dokumenttyp gewählt' : 'ohne Dokumenttyp'),
    name(s?.korrespondenten, v.korrespondent) ?? (v.korrespondentNeu.trim() ? `${v.korrespondentNeu.trim()} (neu)` : null),
    v.folgeaktion.trim() ? `→ ${v.folgeaktion.trim()}` : null].filter(Boolean).join(' · ');
}

export function MetaFelder({ stamm, v, onChange, pflichtDoktyp = false, kompakt = false }: {
  stamm: Stamm; v: Vorgabe; onChange: (v: Vorgabe) => void; pflichtDoktyp?: boolean; kompakt?: boolean;
}) {
  const korrName = v.korrespondent ? stamm.korrespondenten.find((k) => String(k.id) === v.korrespondent)?.name ?? '' : v.korrespondentNeu;
  const neuKorr = !v.korrespondent && !!v.korrespondentNeu.trim();
  const feld = (label: string, inhalt: React.ReactNode, pflicht = false, hinweis?: string) => (
    <div className={kompakt ? 'portal-ablage__feld' : 'portal-up__feld'}>
      <Label required={pflicht} showColon>{label}</Label>
      {inhalt}
      {hinweis && <Text className="portal-muted portal-small">{hinweis}</Text>}
    </div>
  );
  const auswahl = (feldname: 'doktyp' | 'speicherpfad', liste: Eintrag[], leer: string) => (
    <Select style={{ width: '100%' }} onChange={(e) => onChange({ ...v, [feldname]: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
      <Option data-k="" selected={!v[feldname]}>{leer}</Option>
      {liste.map((x) => <Option key={x.id} data-k={String(x.id)} selected={String(x.id) === v[feldname]}>{x.name}</Option>)}
    </Select>
  );
  return (
    <>
      {feld('Dokumenttyp', auswahl('doktyp', stamm.dokumenttypen, pflichtDoktyp ? '– bitte wählen –' : '– keine Angabe –'), pflichtDoktyp)}
      {stamm.folgeaktion && feld('Folgeaktion', stamm.folgeaktion.auswahl ? (
        <Select style={{ width: '100%' }} onChange={(e) => onChange({ ...v, folgeaktion: (e.detail.selectedOption as HTMLElement).dataset.k ?? '' })}>
          <Option data-k="" selected={!v.folgeaktion}>– keine –</Option>
          {stamm.folgeaktion.optionen.map((o) => <Option key={o} data-k={o} selected={o === v.folgeaktion}>{o}</Option>)}
        </Select>
      ) : (
        <ComboBox style={{ width: '100%' }} value={v.folgeaktion} placeholder="Was ist mit dem Dokument zu tun?" showClearIcon noTypeahead
                  onInput={(e) => onChange({ ...v, folgeaktion: e.target.value })}
                  onSelectionChange={(e) => onChange({ ...v, folgeaktion: (e.detail.item as HTMLElement | null)?.getAttribute('text') ?? v.folgeaktion })}>
          {stamm.folgeaktion.optionen.map((o) => <ComboBoxItem key={o} text={o} />)}
        </ComboBox>
      ), false, stamm.folgeaktion.vorhanden ? undefined : `Wird in Paperless als Feld „${stamm.folgeaktion.feld}“ angelegt.`)}
      {feld('Korrespondent', (
        <ComboBox style={{ width: '100%' }} value={korrName} placeholder="wählen oder neuen Namen eingeben" showClearIcon noTypeahead
                  valueState={neuKorr ? 'Information' : 'None'}
                  valueStateMessage={<span>„{v.korrespondentNeu.trim()}“ wird beim Ablegen in Paperless neu angelegt.</span>}
                  onInput={(e) => {
                    const t = e.target.value;
                    const treffer = stamm.korrespondenten.find((k) => k.name.toLowerCase() === t.trim().toLowerCase());
                    onChange({ ...v, korrespondent: treffer ? String(treffer.id) : '', korrespondentNeu: treffer ? '' : t });
                  }}
                  onSelectionChange={(e) => {
                    const id = (e.detail.item as HTMLElement | null)?.dataset.k ?? '';
                    onChange({ ...v, korrespondent: id, korrespondentNeu: '' });
                  }}>
          {stamm.korrespondenten.map((k) => <ComboBoxItem key={k.id} data-k={String(k.id)} text={k.name} />)}
        </ComboBox>
      ), false, neuKorr ? 'Neuer Korrespondent – wird beim ersten Ablegen angelegt.' : undefined)}
      {feld('Speicherpfad', auswahl('speicherpfad', stamm.speicherpfade, '– Standard von Paperless –'))}
      {feld('Notiz (an jedes Dokument)', <Input style={{ width: '100%' }} value={v.notiz} maxlength={500} onInput={(e) => onChange({ ...v, notiz: e.target.value })} />)}
    </>
  );
}
