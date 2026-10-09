import { admin } from './admin';
import { auth } from './auth';
import { bookings } from './bookings';
import { common } from './common';
import { manage } from './manage';
import { social } from './social';
import { venues } from './venues';

/** Un fichier par domaine ; un test vérifie qu'aucune clé n'existe dans deux fichiers à la fois. */
export const messageSources = [common, auth, venues, bookings, social, manage, admin] as const;

export const messages = { ...common, ...auth, ...venues, ...bookings, ...social, ...manage, ...admin };
export type MessageKey = keyof typeof messages;
