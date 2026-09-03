import 'dotenv/config';
import { migrate } from 'drizzle-orm/neon-http/migrator';

import { db } from './db/client';

async function main() {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
