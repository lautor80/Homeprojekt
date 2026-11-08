import {
  ComboBox, ComboBoxItem, Input, Label, MultiComboBox, MultiComboBoxItem, Option, Select, Text,
} from '@ui5/webcomponents-react';

/**
 * Gemeinsame Paperless-Metadaten für Ablagefeld (Navigation) und Dokumenten-Upload:
 * Dokumenttyp, Korrespondent (wählen ODER neuen Namen eintippen – wird beim Ablegen in Paperless angelegt),
 * Tags (wählen und/oder neue eintippen), Speicherpfad, Notiz. Die Voreinstellung wird je Benutzer im Browser gespeichert
 * und von beiden Stellen gemeinsam genutzt.
 */
export interface Eintrag { id: number; name: string }
export interface Stamm { paperless: boolean; dokumenttypen: Eintrag[]; korrespondenten: Eintrag[]; tags: Eintrag[]; speicherpfade: Eintrag[]; heute: string; dateitypen: string[] }
export interface Vorgabe { doktyp: string; korrespondent: string; korrespondentNeu: string; tags: number[]; tagsNeu: string; speicherpfad: string; notiz: string }

export const LEER: Vorgabe = { doktyp: '', korrespondent: '', korrespondentNeu: '', tags: [], tagsNeu: '', speicherpfad: '', notiz: '' };
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
    tags: v.tags, tagsNeu: v.tagsNeu.split(',').map((t) => t.trim()).filter(Boolean),
    speicherpfad: v.speicherpfad ? Number(v.speicherpfad) : null, notiz: v.notiz,
  };
}

/** Kurzbeschreibung der Voreinstellung (Ablagefeld) */
export function vorgabeText(v: Vorgabe | null, s: Stamm | null): string {
  if (!v) return 'Noch nicht voreingestellt';
  const name = (l: Eintrag[] | undefined, id: string) => l?.find((x) => String(x.id) === id)?.name;
  const tags = v.tags.length + v.tagsNeu.split(',').filter((t) => t.trim()).length;
  return [name(s?.dokumenttypen, v.doktyp) ?? (v.doktyp ? 'Dokumenttyp gewählt' : 'ohne Dokumenttyp'),
    name(s?.korrespondenten, v.korrespondent) ?? (v.korrespondentNeu.trim() ? `${v.korrespondentNeu.trim()} (neu)` : null),
    tags ? `${tags} Tag(s)` : null].filter(Boolean).join(' · ');
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
      {feld('Korrespondent', (
        <ComboBox style={{ width: '100%' }} value={korrName} placeholder="wählen oder neuen Namen eingeben" showClearIcon
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
      {feld('Tags', (
        <MultiComboBox style={{ width: '100%' }} placeholder="keine"
                       onSelectionChange={(e) => onChange({ ...v, tags: e.detail.items.map((i) => Number((i as HTMLElement).dataset.id)) })}>
          {stamm.tags.map((t) => <MultiComboBoxItem key={t.id} data-id={t.id} text={t.name} selected={v.tags.includes(t.id)} />)}
        </MultiComboBox>
      ))}
      {feld('Neue Tags (durch Komma getrennt)', <Input style={{ width: '100%' }} value={v.tagsNeu} placeholder="z. B. Beleg 2026, Clubhaus" onInput={(e) => onChange({ ...v, tagsNeu: e.target.value })} />)}
      {feld('Speicherpfad', auswahl('speicherpfad', stamm.speicherpfade, '– Standard von Paperless –'))}
      {feld('Notiz (an jedes Dokument)', <Input style={{ width: '100%' }} value={v.notiz} maxlength={500} onInput={(e) => onChange({ ...v, notiz: e.target.value })} />)}
    </>
  );
}
