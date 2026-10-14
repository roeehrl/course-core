import { normalizeLoginName } from './passwords.js';

export const SET_PASSWORD_USAGE = 'Usage: set-password <workspace-slug> <subject> [--login <login-name>] [--temporary]\n'
  + 'Reads the password from the terminal (not echoed) or from standard input. Run only on the trusted server host.';
/** Strict parsing: exactly two positional arguments. A password must never be passed on
 * the command line, where it would land in shell history and process listings. */
export function parseSetPasswordArguments(args: string[]) {
  const positional: string[] = [];
  let login: string | undefined, temporary = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--login' && login === undefined && i + 1 < args.length) login = args[++i]!;
    else if (arg === '--temporary' && !temporary) temporary = true;
    else if (arg.startsWith('-')) throw new Error(SET_PASSWORD_USAGE);
    else positional.push(arg);
  }
  if (positional.length !== 2 || !/^[a-z][a-z0-9-]{0,99}$/.test(positional[0]!) || !positional[1]!.trim() || positional[1]!.length > 300) throw new Error(SET_PASSWORD_USAGE);
  const loginName = login === undefined ? undefined : normalizeLoginName(login);
  if (login !== undefined && !loginName) throw new Error('Login names are 3-128 characters: a-z, 0-9 and . _ @ + : - (letters or digits at both ends).');
  return { workspace: positional[0]!, subject: positional[1]!, loginName, temporary };
}

