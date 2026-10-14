import { createDatabase, transaction } from './database.js';
import { ApiError } from './errors.js';
import { hashPassword, normalizeLoginName, passwordPolicy, storePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords.js';
import { readNewPassword } from './secret-input.js';
import { parseSetPasswordArguments } from './set-password.js';

try {
  const parsed = parseSetPasswordArguments(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  let password: string;
  try { password = passwordPolicy(await readNewPassword()); }
  catch (error) {
    if (error instanceof ApiError) throw new Error(`Passwords must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters. Nothing was changed.`);
    throw error;
  }
  const hash = await hashPassword(password);
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const result = await transaction(db, async client => {
      const user = (await client.query<{ id: string; login_name: string | null }>(
        `SELECT u.id,u.login_name FROM app_users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id
         WHERE w.slug=$1 AND u.subject=$2`, [parsed.workspace, parsed.subject])).rows[0];
      if (!user) throw new Error('No member with that subject exists in that workspace. Nothing was changed.');
      const loginName = parsed.loginName ?? user.login_name ?? normalizeLoginName(parsed.subject);
      if (!loginName) throw new Error('The subject is not a valid login name; choose one with --login <login-name>.');
      const stored = await storePassword(client, user.id, hash, { mustChange: parsed.temporary, loginName });
      return { userId: user.id, loginName, mustChangeOnNextSignIn: parsed.temporary, sessionsRevoked: stored.sessionsRevoked };
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await db.end(); }
} catch (error) {
  const message = error instanceof ApiError && error.code === 'LOGIN_NAME_TAKEN' ? 'That login name belongs to another account. Nothing was changed.'
    : ['42P01', '42703'].includes((error as { code?: string }).code ?? '') ? 'The database schema is out of date; start the API (or run migrate) first.'
      : error instanceof Error && !(error as { code?: string }).code ? error.message : 'Setting the password failed. Nothing was changed.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
