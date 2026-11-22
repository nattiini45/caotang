import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function applyMigrations(db: Pick<D1Database, 'prepare' | 'batch'>, names: string[]): Promise<void> {
  for (const name of names) {
    const sql = readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), 'utf8');
    const statements = sql.split(/(?<=;)\s*(?=CREATE|$)/).filter((statement) => statement.trim());
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}
