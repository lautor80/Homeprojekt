/** Theme-Variablen, die mit der Organisationsfarbe überschrieben werden. */
const BRAND_VARS = [
  '--sapBrandColor',
  '--sapButton_Emphasized_Background',
  '--sapButton_Emphasized_BorderColor',
  '--sapHighlightColor',
  '--sapSelectedColor',
  '--portalBrand',
];

/**
 * Organisationsname und -farbe übernehmen.
 * Die Farbe ersetzt die Akzentfarbe des SAP-Horizon-Themes (Buttons, Auswahl,
 * Markierungen) – so wie heute das Orange beim TCO.
 */
export function applyBranding(settings: Record<string, unknown>): void {
  document.title = (settings['org.name'] as string) || 'Portal';
  const color = settings['org.color'] as string | undefined;
  const root = document.documentElement.style;
  for (const v of BRAND_VARS) {
    if (color) root.setProperty(v, color);
    else root.removeProperty(v);
  }
}
