/**
 * Egress canary scanner shared by the end-to-end sweep. A marker counts as leaked when its
 * plain text or a common transport encoding of it (JSON-escaped, URL-encoded, base64 at any
 * byte alignment, hex) appears in a channel's captured bytes.
 */
export interface Channel { name: string; text: string }
export interface Leak { channel: string; marker: string; form: string }

function base64Forms(marker: string) {
  // A substring's base64 depends on its offset modulo 3, so cover each alignment and drop the
  // edge characters that mix in neighbouring bytes.
  const forms: string[] = [];
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.from('\0'.repeat(pad) + marker).toString('base64').replace(/=+$/, '');
    const core = encoded.slice(pad ? 4 : 0, -4);
    if (core.length >= 12) forms.push(core, core.replaceAll('+', '-').replaceAll('/', '_'));
  }
  return forms;
}
export function markerForms(marker: string): { form: string; text: string }[] {
  const forms = [{ form: 'plain', text: marker }, { form: 'json', text: JSON.stringify(marker).slice(1, -1) },
    { form: 'url', text: encodeURIComponent(marker) }, { form: 'hex', text: Buffer.from(marker).toString('hex') },
    ...base64Forms(marker).map(text => ({ form: 'base64', text }))];
  const seen = new Set<string>();
  return forms.filter(f => f.text.length >= 8 && !seen.has(f.form + f.text) && seen.add(f.form + f.text));
}
export function findLeaks(channels: Channel[], markers: string[]): Leak[] {
  const leaks: Leak[] = [];
  for (const channel of channels) for (const marker of markers) {
    const hit = markerForms(marker).find(f => channel.text.includes(f.text));
    if (hit) leaks.push({ channel: channel.name, marker, form: hit.form });
  }
  return leaks;
}
