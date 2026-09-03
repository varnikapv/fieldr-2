import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Put your Neon connection string in server/.env',
  );
}

// neon-http: one HTTPS request per query, no long-lived pool. Note it does not
// support transactions — every write below is a single statement for that
// reason.
export const db = drizzle(neon(connectionString), { schema });
