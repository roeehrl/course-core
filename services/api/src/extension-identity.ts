/** An exact (version, integrity) build identity a course can declare for an installed extension. */
export interface BuildIdentity { readonly version: string; readonly integrity: string }

/** What an installed adapter exposes for identity checks. */
export interface InstalledIdentity extends BuildIdentity {
  /** Reviewed prior builds this adapter still serves exactly. Empty or absent for most adapters. */
  readonly acceptedPriorBuilds?: readonly BuildIdentity[];
}

/**
 * The single declaration-vs-installed identity check. A course declaration matches
 * only the installed build itself, or one of the adapter's explicitly reviewed prior
 * builds, each compared as an exact (version, integrity) pair. Nothing else is
 * accepted: no version ranges, no integrity from a different version.
 */
export function declarationMatchesInstalled(declaration: { version: string; integrity: string } | undefined, adapter: InstalledIdentity | undefined): boolean {
  if (!declaration || !adapter) return false;
  const same = (build: BuildIdentity) => build.version === declaration.version && build.integrity === declaration.integrity;
  return same(adapter) || (adapter.acceptedPriorBuilds ?? []).some(same);
}
