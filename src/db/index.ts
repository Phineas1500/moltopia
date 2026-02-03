import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { env } from '../env.js';

// Create postgres connection
const queryClient = postgres(env.DATABASE_URL, {
  max: 20, // Connection pool size
  idle_timeout: 20,
  connect_timeout: 10,
});

// Create drizzle instance
export const db = drizzle(queryClient, { schema });

// Export a close function for graceful shutdown
export async function closeDatabase() {
  await queryClient.end();
}
