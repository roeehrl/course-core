import { constants } from "node:fs";
import { open, mkdir, lstat, link, unlink } from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { requireCondition } from "./errors.js";
import { canonicalJson } from "@course-core/sdk/compiler";

/** Host-created key, never a browser/env credential lookup. Ciphertext is scoped
 * with authenticated workspace/version/binding AAD. No plaintext readback API. */
export interface CredentialVault {
  seal(scope: string, value: string): string;
  open(scope: string, value: string): string;
  requestDigest(scope: string, value: unknown): string;
}
export function credentialVault(key: Uint8Array): CredentialVault {
  requireCondition(key.byteLength === 32, "PROVIDER_VAULT_UNAVAILABLE", 503);
  const master = Buffer.from(key);
  return {
    seal(scope, value) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", master, nonce);
      cipher.setAAD(Buffer.from(scope));
      const body = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString(
        "base64",
      );
    },
    open(scope, value) {
      try {
        const bytes = Buffer.from(value, "base64");
        requireCondition(bytes.length >= 28, "PROVIDER_VAULT_UNAVAILABLE", 503);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          master,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(scope));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        requireCondition(false, "PROVIDER_VAULT_UNAVAILABLE", 503);
      }
    },
    requestDigest(scope, value) {
      return createHmac("sha256", master)
        .update(scope)
        .update("\0")
        .update(canonicalJson(value))
        .digest("hex");
    },
  };
}
export async function localCredentialVault(
  directory: string,
): Promise<CredentialVault> {
  requireCondition(
    path.isAbsolute(directory),
    "PROVIDER_VAULT_UNAVAILABLE",
    503,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  requireCondition(
    dir.isDirectory() &&
      !dir.isSymbolicLink() &&
      (dir.mode & 0o777) === 0o700 &&
      dir.uid === process.getuid?.(),
    "PROVIDER_VAULT_UNAVAILABLE",
    503,
  );
  const filename = path.join(directory, "provider-key.bin");
  try {
    await lstat(filename);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const staging = path.join(directory, ".key-" + randomUUID()),
      file = await open(staging, "wx", 0o600);
    try {
      await file.writeFile(randomBytes(32));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(staging, filename);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await unlink(staging);
    }
    const folder = await open(directory, constants.O_RDONLY);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const meta = await file.stat();
    requireCondition(
      meta.isFile() &&
        meta.nlink === 1 &&
        (meta.mode & 0o777) === 0o600 &&
        meta.uid === process.getuid?.() &&
        meta.size === 32,
      "PROVIDER_VAULT_UNAVAILABLE",
      503,
    );
    return credentialVault(await file.readFile());
  } finally {
    await file.close();
  }
}
