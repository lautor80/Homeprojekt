import type { ComponentType } from 'react';
import type { LiveProps, Modus, VerwaltungProps } from './api';
import { KoVerwaltung } from './ko/KoVerwaltung';
import { KoLive } from './ko/KoLive';
import { LigaVerwaltung } from './liga/LigaVerwaltung';
import { LigaLive } from './liga/LigaLive';
import { SpassVerwaltung } from './spass/SpassVerwaltung';
import { SpassLive } from './spass/SpassLive';

/** je Modus: Reiter in der Verwaltung und Live-Ansicht */
export const MODUS_UI: Record<Modus, { Verwaltung: ComponentType<VerwaltungProps>; Live: ComponentType<LiveProps<any>>; reiter: string }> = {
  ko: { Verwaltung: KoVerwaltung, Live: KoLive, reiter: 'Tableau' },
  liga: { Verwaltung: LigaVerwaltung, Live: LigaLive, reiter: 'Gruppen und Monate' },
  spass: { Verwaltung: SpassVerwaltung, Live: SpassLive, reiter: 'Runden' },
};
