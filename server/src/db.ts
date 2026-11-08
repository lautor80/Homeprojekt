import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {},
  transform: { undefined: null },
  types: {
    // Spalten vom Typ "date" als Text JJJJ-MM-TT liefern (keine Zeitzonen-Verschiebung)
    date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
  },
});

export type Sql = typeof sql;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

/** Wer ändert gerade? Wird an die Änderungsbeleg-Trigger weitergereicht. */
export interface ChangeContext {
  userId: string | null;
  username: string;
  /** Optionale Begründung, landet im Kopf des Änderungsbelegs. */
  reason?: string | null;
  /** Fachliche Aktion, z. B. "STORNO" oder "PASSWORT_RESET". */
  action?: string | null;
  /** Anmeldesitzung (Hash), für die Sperrprüfung im Trigger; leer = keine Sperrprüfung (API, Hintergrund) */
  sitzung?: string | null;
}

/**
 * Führt fn in einer Transaktion aus und setzt die Session-Variablen,
 * die der generische Trigger core.audit_trigger() für den Änderungsbeleg ausliest.
 */
export async function withChange<T>(ctx: ChangeContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select
      set_config('app.user_id',  ${ctx.userId ?? ''}, true),
      set_config('app.username', ${ctx.username}, true),
      set_config('app.reason',   ${ctx.reason ?? ''}, true),
      set_config('app.action',   ${ctx.action ?? ''}, true),
      set_config('app.sitzung',  ${ctx.sitzung ?? ''}, true)`;
    return fn(tx as unknown as Tx);
  }) as Promise<T>;
}
