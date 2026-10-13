import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  rm,
  chmod,
  readFile,
  lstat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import {
  credentialVault,
  localCredentialVault,
} from "../src/credential-vault.js";
it("authenticated encryption rejects another tenant, version, binding, key and tampered ciphertext", () => {
  const vault = credentialVault(randomBytes(32)),
    scope = "workspace-1/revision-1/key-1",
    secret = "TEST_SECRET_CANARY",
    a = vault.seal(scope, secret),
    b = vault.seal(scope, secret);
  expect(a).not.toBe(b);
  expect(a).not.toContain(secret);
  expect(vault.open(scope, a)).toBe(secret);
  for (const changed of [
    "workspace-2/revision-1/key-1",
    "workspace-1/revision-2/key-1",
    "workspace-1/revision-1/key-2",
  ])
    expect(() => vault.open(changed, a)).toThrow();
  const bytes = Buffer.from(a, "base64");
  bytes[30] = bytes[30]! ^ 1;
  expect(() => vault.open(scope, bytes.toString("base64"))).toThrow();
  expect(() => credentialVault(randomBytes(32)).open(scope, a)).toThrow();
  expect(vault.requestDigest("one", { secret })).not.toBe(
    vault.requestDigest("two", { secret }),
  );
  expect(vault.requestDigest("one", { a: 1, b: 2 })).toBe(
    vault.requestDigest("one", { b: 2, a: 1 }),
  );
});
it("persists one protected host key across restarts and refuses links, permissive files and corrupt keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "course-vault-"));
  try {
    const a = await localCredentialVault(root),
      sealed = a.seal("scope", "SECRET"),
      file = path.join(root, "provider-key.bin");
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file)).length).toBe(32);
    expect((await localCredentialVault(root)).open("scope", sealed)).toBe(
      "SECRET",
    );
    await chmod(file, 0o644);
    await expect(localCredentialVault(root)).rejects.toThrow();
    await chmod(file, 0o600);
    await writeFile(file, "broken", { mode: 0o600 });
    await expect(localCredentialVault(root)).rejects.toThrow();
    await rm(file);
    await symlink("/dev/null", file);
    await expect(localCredentialVault(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
