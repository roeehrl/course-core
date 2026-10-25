import type { Database } from '../src/database.js';

/**
 * Tables of the current schema with rows whose text contains `needle` (or any of several),
 * as `table:rows`, for tests that prove a value is (or is no longer) stored anywhere. One
 * statement: the server runs each table's count itself (`query_to_xml`), so a scan of all
 * ~200 tables is one round trip instead of one per table, and several needles share one
 * pass. Per-table queries made each scan hundreds of round trips, which on a loaded machine
 * pushed the erasure tests past their timeouts. Needles are matched with LIKE as given;
 * canaries and digests contain no wildcards.
 */
export async function tablesContaining(db: Pick<Database, 'query'>, needle: string | readonly string[]): Promise<string[]> {
  const patterns = (typeof needle === 'string' ? [needle] : [...needle]).map(value => `%${value}%`);
  if (!patterns.length) throw new Error('tablesContaining needs at least one needle.');
  const { rows } = await db.query<{ table_name: string; n: number }>(
    `SELECT table_name, (xpath('/row/n/text()', query_to_xml(
        format('SELECT count(*) AS n FROM %I.%I t WHERE t::text LIKE ANY (%L::text[])', table_schema, table_name, $1::text[]), false, true, '')))[1]::text::int AS n
       FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [patterns]);
  return rows.filter(row => row.n > 0).map(row => `${row.table_name}:${row.n}`);
}

/** The names of the tables `tablesContaining` finds. */
export async function tableNamesContaining(db: Pick<Database, 'query'>, needle: string | readonly string[]): Promise<string[]> {
  return (await tablesContaining(db, needle)).map(hit => hit.slice(0, hit.lastIndexOf(':')));
}
