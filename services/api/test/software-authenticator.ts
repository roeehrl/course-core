import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// A minimal software WebAuthn authenticator for tests: ES256 keys, "none" attestation,
// discoverable credentials. It produces the same JSON a browser hands to the server,
// and lets a test forge the parts a real authenticator would not (origin, RP, counter).

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [key: string]: Cbor };
function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(value, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(value, 1); return b;
}
export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
export interface Forgery { origin?: string; rpId?: string; type?: string; userVerified?: boolean; counter?: number; challenge?: string; credentialId?: string }
export interface SoftCredential { id: string; userHandle: string; privateKey: KeyObject; counter: number; rpId: string }

export class SoftwareAuthenticator {
  readonly credentials: SoftCredential[] = [];
  constructor(readonly origin: string) {}

  private authData(rpId: string, counter: number, flags: number, attested?: Buffer) {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    return Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() for the options the server issued. */
  create(options: { challenge: string; rp: { id?: string }; user: { id: string } }, forge: Forgery = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const rawId = forge.credentialId ? Buffer.from(forge.credentialId, 'base64url') : randomBytes(32), id = rawId.toString('base64url'), rpId = options.rp.id!;
    const length = Buffer.alloc(2); length.writeUInt16BE(rawId.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, rawId, cose]);
    const flags = FLAG_UP | FLAG_AT | (forge.userVerified === false ? 0 : FLAG_UV);
    const authData = this.authData(forge.rpId ?? rpId, forge.counter ?? 0, flags, attested);
    const credential: SoftCredential = { id, userHandle: options.user.id, privateKey, counter: forge.counter ?? 0, rpId };
    this.credentials.push(credential);
    return {
      credential,
      response: {
        id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
        response: {
          clientDataJSON: this.clientData(forge.type ?? 'webauthn.create', forge.challenge ?? options.challenge, forge.origin ?? this.origin).toString('base64url'),
          attestationObject: cbor({ fmt: 'none', attStmt: {}, authData }).toString('base64url'),
          transports: ['internal', 'hybrid'],
        },
      },
    };
  }

  /** navigator.credentials.get() with a chosen credential. Counters increase by one
   * per assertion unless forged. */
  get(options: { challenge: string; rpId?: string }, credential: SoftCredential, forge: Forgery = {}) {
    const counter = forge.counter ?? ++credential.counter;
    const authData = this.authData(forge.rpId ?? options.rpId ?? credential.rpId, counter, FLAG_UP | (forge.userVerified === false ? 0 : FLAG_UV));
    const clientDataJSON = this.clientData(forge.type ?? 'webauthn.get', forge.challenge ?? options.challenge, forge.origin ?? this.origin);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), credential.privateKey);
    return {
      id: credential.id, rawId: credential.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'), userHandle: credential.userHandle,
      },
    };
  }
}
