import type { Database } from './database.js';

const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
/** Grants a separate login role data access only: no DDL, TRUNCATE, ownership
 * or schema creation. Run with the migration (owner) connection. */
export async function grantRuntimeAccess(owner: Database, role: string) {
  if (!identifier.test(role)) throw new Error('Runtime role name is not a plain identifier.');
  const found = (await owner.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
    'SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1', [role])).rows[0];
  if (!found) throw new Error('Runtime role does not exist.');
  if (found.rolsuper || found.rolcreaterole || found.rolcreatedb) throw new Error('Runtime role must not be a superuser or create roles/databases.');
  const owned = await owner.query("SELECT 1 FROM pg_tables WHERE schemaname=current_schema() AND tableowner=$1 LIMIT 1", [role]);
  if (owned.rowCount) throw new Error('Runtime role must not own application tables.');
  const schema = (await owner.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
  if (!identifier.test(schema)) throw new Error('Unexpected schema name.');
  for (const sql of [
    `REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
    `REVOKE TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
    `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
  ]) await owner.query(sql);
}
/** Refuses to serve as a role that could alter the schema. */
export async function assertRuntimePrivileges(db: Database) {
  const row = (await db.query<{ superuser: boolean; can_create: boolean; owns: boolean }>(
    `SELECT r.rolsuper AS superuser,has_schema_privilege(current_user,current_schema(),'CREATE') AS can_create,
       EXISTS(SELECT 1 FROM pg_tables WHERE schemaname=current_schema() AND tableowner=current_user) AS owns
     FROM pg_roles r WHERE r.rolname=current_user`)).rows[0]!;
  if (row.superuser || row.can_create || row.owns) throw new Error('DATABASE_URL must use a least-privilege runtime role when MIGRATION_DATABASE_URL is set.');
}
