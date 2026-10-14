/** Reads a password for a host CLI: from the controlling terminal without echo, or from
 * standard input when it is not a terminal. Never from argv or the environment. */
const STDIN_LIMIT = 16 * 1024;

function promptHidden(prompt: string): Promise<string> {
  const input = process.stdin, output = process.stderr;
  return new Promise((resolve, reject) => {
    let value = '';
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003' || character === '\u0004') return finish(new Error('Password entry cancelled.'));
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ') value += character;
        if (value.length > STDIN_LIMIT) return finish(new Error('Password is too long.'));
      }
    };
    input.on('data', onData);
  });
}
async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    if (text.length > STDIN_LIMIT) throw new Error('Password input is too long.');
  }
  const value = text.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(value)) throw new Error('Provide exactly one password line on standard input.');
  return value;
}
export async function readNewPassword(label = 'New password'): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  const first = await promptHidden(`${label}: `);
  const second = await promptHidden(`Repeat ${label.toLowerCase()}: `);
  if (first !== second) throw new Error('The passwords do not match. Nothing was changed.');
  return first;
}
