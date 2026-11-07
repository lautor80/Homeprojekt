import fs from 'node:fs';
import path from 'node:path';
import { sql, type Tx } from '../../../server/src/db.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { Paperless, paperlessKonfiguriert } from '../../../server/src/lib/paperless.js';

export type Db = Tx;
export const DB = sql as unknown as Tx;

export interface Verein {
  name: string;
  strasse: string | null;
  plz_ort: string | null;
  iban: string | null;
  bic: string | null;
  bank: string | null;
  steuernr: string | null;
  ansprechpartner: string | null;
  email: string | null;
  zahlungsziel_tage: number;
  logo: string | null;
  paperless_url: string | null;
  paperless_token: string | null;
  n8n_mail_url: string | null;
  n8n_mail_key: string | null;
  n8n_ep3_url: string | null;
  n8n_ep3_auth: string | null;
  n8n_stunden_url: string | null;
  n8n_ferien_url: string | null;
  n8n_stunden_auth: string | null;
  n8n_stunden_user: string | null;
  n8n_ep3_user: string | null;
  halle_stichtag: string;
  halle_ausschluss: string;
  halle_plaetze: string;
  fi_bankkonten: string;
  fi_manuell_konten: string;
  fi_beleg_typen: string;
  fi_beleg_pfad: string;
  fi_feld_beleg: string;
  fi_feld_betrag: string;
  fi_feld_sap: string;
  ch_konto_einnahmen: string;
  ch_konto_ware: string;
  ch_reinigung: number;
  ch_provision: number;
  ch_wirt: string;
  ch_feld_json: string;
}

/** Komma-Liste aus den Einstellungen */
export const liste = (s: string | null | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export async function vereinLesen(db: Db = DB): Promise<Verein> {
  const [v] = await db`select * from tco.verein where id = 1`;
  return v as unknown as Verein;
}

export const plAktiv = (v: Verein) => paperlessKonfiguriert({ url: v.paperless_url, token: v.paperless_token });

export function paperless(v: Verein): Paperless {
  return new Paperless({ url: v.paperless_url, token: v.paperless_token });
}

const ASSETS = path.join(APP_ROOT, 'modules', 'tco', 'server', 'assets');
const assetCache = new Map<string, Buffer>();
export function asset(name: string): Buffer {
  let b = assetCache.get(name);
  if (!b) {
    b = fs.readFileSync(path.join(ASSETS, name));
    assetCache.set(name, b);
  }
  return b;
}

/** Logo für Ausdrucke: hinterlegtes Logo oder das Vereinslogo (weiß für das orange Kopfband) */
export function logoWeiss(v: Verein): Buffer | string {
  return v.logo || asset('logo_weiss.png');
}
