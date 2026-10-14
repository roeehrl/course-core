import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase, transaction } from './database.js';
import { migrate } from './migrations.js';
import { issueLoginCode, parseLoginCodes } from './auth.js';
import { ApiError } from './errors.js';
import { hashPassword, normalizeLoginName, passwordPolicy, storePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords.js';
import { readNewPassword } from './password-input.js';

const usage = 'Usage: bootstrap <workspace-slug> <user-subject> <display-name> [--password | --no-password] [--login <login-name>]. Run only on the trusted server host.\n'
  + 'With --password (the default on an interactive terminal) the owner password is read from the terminal without echo, or from standard input.';
const positional: string[] = [];
let passwordMode: boolean | undefined, login: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if ((arg === '--password' || arg === '--no-password') && passwordMode === undefined) passwordMode = arg === '--password';
  else if (arg === '--login' && login === undefined && i + 1 < argv.length) login = argv[++i]!;
  else if (arg.startsWith('--')) throw new Error(usage);
  else positional.push(arg);
}
if (positional.length !== 3 || !/^[a-z][a-z0-9-]{0,99}$/.test(positional[0]!) || !positional[1]?.trim() || !positional[2]?.trim()) throw new Error(usage);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const loginCodes = parseLoginCodes(process.env.AUTH_LOGIN_CODES);
const [slug, subject, displayName] = positional as [string, string, string];
const wantsPassword = passwordMode ?? Boolean(process.stdin.isTTY);
const loginName = login !== undefined ? normalizeLoginName(login) : normalizeLoginName(subject);
if (wantsPassword && !loginName) throw new Error('The subject is not a valid login name; choose one with --login <login-name>.');
let passwordHash: string | undefined;
if (wantsPassword) {
  let password: string;
  try { password = passwordPolicy(await readNewPassword('Owner password')); }
  catch (error) { if (error instanceof ApiError) throw new Error(`Passwords must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters. Nothing was created.`); throw error; }
  passwordHash = await hashPassword(password);
}
const db = createDatabase(process.env.DATABASE_URL);
try {
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const result = await transaction(db, async client => {
    const workspace = await client.query<{ id: string }>('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$2) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id', [randomUUID(), slug]);
    const user = await client.query<{ id: string }>('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id', [randomUUID(), subject, displayName]);
    await client.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING", [workspace.rows[0]!.id, user.rows[0]!.id]);
    if (passwordHash) await storePassword(client, user.rows[0]!.id, passwordHash, { mustChange: false, loginName: loginName! });
    return { workspaceId: workspace.rows[0]!.id, userId: user.rows[0]!.id };
  });
  const output: Record<string, unknown> = { ...result };
  if (passwordHash) output.loginName = loginName;
  else output.next = `Set a password: npm --prefix services/api run set-password -- ${slug} ${subject}`;
  if (loginCodes) {
    // One-time codes are off unless AUTH_LOGIN_CODES=enabled for both this CLI and the API.
    const code = await issueLoginCode(db, result.userId);
    const url = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:4310');
    url.hash = `signin=${code}`;
    Object.assign(output, { expiresInMinutes: 10, oneTimeSignInUrl: url.toString() });
  }
  process.stdout.write(JSON.stringify(output) + '\n');
} finally { await db.end(); }
