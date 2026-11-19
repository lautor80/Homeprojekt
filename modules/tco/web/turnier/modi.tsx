import type { ComponentType } from 'react';
import type { LiveProps, MeinProps, Modus, VerwaltungProps } from './api';
import { KoVerwaltung } from './ko/KoVerwaltung';
import { KoLive } from './ko/KoLive';
import { LigaVerwaltung } from './liga/LigaVerwaltung';
import { LigaLive } from './liga/LigaLive';
import { LigaMein } from './liga/LigaMein';
import { SpassVerwaltung } from './spass/SpassVerwaltung';
import { SpassLive } from './spass/SpassLive';
import { SpassMein } from './spass/SpassMein';

/** je Modus: Reiter in der Verwaltung, Live-Ansicht und optionale Ergänzung auf „Mein Turnier“ (persönlicher Link) */
export const MODUS_UI: Record<Modus, { Verwaltung: ComponentType<VerwaltungProps>; Live: ComponentType<LiveProps<any>>; reiter: string; Mein?: ComponentType<MeinProps> }> = {
  ko: { Verwaltung: KoVerwaltung, Live: KoLive, reiter: 'Tableau' },
  liga: { Verwaltung: LigaVerwaltung, Live: LigaLive, reiter: 'Gruppen und Monate', Mein: LigaMein },
  spass: { Verwaltung: SpassVerwaltung, Live: SpassLive, reiter: 'Runden', Mein: SpassMein },
};
