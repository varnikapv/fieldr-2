import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import * as schema from './schema';

export const DATABASE_NAME = 'fieldnote.db';

// One connection for the lifetime of the app. `enableChangeListener` is what
// lets drizzle's useLiveQuery re-run its query when a write lands, instead of
// us refetching by hand after every insert.
const sqliteDb = openDatabaseSync(DATABASE_NAME, { enableChangeListener: true });

export const db = drizzle(sqliteDb, { schema });
