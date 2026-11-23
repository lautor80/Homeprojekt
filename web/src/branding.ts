let portalUrl: string | null = null;

/**
 * Basis für Links, die weitergegeben werden (Website, Aushang, QR-Code, Einladungen): die eingestellte Portal-Adresse
 * (Administration → Einstellungen), nur ohne sie die Adresse, unter der das Portal gerade geöffnet ist.
 */
export function portalAdresse(): string {
  return portalUrl ?? window.location.origin;
}

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
  const url = settings['portal.url'];
  portalUrl = typeof url === 'string' && url.trim() ? url.trim().replace(/\/+$/, '') : null;
  document.title = (settings['org.name'] as string) || 'Portal';
  const color = settings['org.color'] as string | undefined;
  const root = document.documentElement.style;
  for (const v of BRAND_VARS) {
    if (color) root.setProperty(v, color);
    else root.removeProperty(v);
  }
  appSymbol(settings['org.logo'] as string | undefined);
}

/**
 * Symbol für „Zum Home-Bildschirm“ (iPhone): das Logo der Organisation, eingepasst in ein weißes Quadrat –
 * ohne Logo bleibt das Standardsymbol aus index.html. Scheitert das Zeichnen, bleibt es ebenfalls dabei.
 */
function appSymbol(logo?: string): void {
  if (!logo) return;
  const bild = new Image();
  bild.onload = () => {
    try {
      const n = 180, rand = 14;
      const c = document.createElement('canvas');
      c.width = n; c.height = n;
      const g = c.getContext('2d');
      if (!g || !bild.width || !bild.height) return;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, n, n);
      const f = Math.min((n - 2 * rand) / bild.width, (n - 2 * rand) / bild.height);
      g.drawImage(bild, (n - bild.width * f) / 2, (n - bild.height * f) / 2, bild.width * f, bild.height * f);
      document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', c.toDataURL('image/png'));
    } catch { /* Standardsymbol bleibt */ }
  };
  bild.src = logo;
}
