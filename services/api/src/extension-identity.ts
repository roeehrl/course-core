/** An exact (version, integrity) build identity a course can declare for an installed extension. */
export interface BuildIdentity { readonly version: string; readonly integrity: string }

/** What an installed adapter exposes for identity checks. */
export interface InstalledIdentity extends BuildIdentity {
  /**
   * Other exact declarations this adapter serves: reviewed prior builds and, for the svg
   * renderer, the installed build's own executed identity. Empty or absent for most adapters.
   */
  readonly acceptedPriorBuilds?: readonly BuildIdentity[];
}

/**
 * The single declaration-vs-installed identity check. A course declaration matches
 * only the installed build itself, or one of the adapter's explicitly listed alternative
 * declarations, each compared as an exact (version, integrity) pair. Nothing else is
 * accepted: no version ranges, no integrity from a different version.
 */
export function declarationMatchesInstalled(declaration: { version: string; integrity: string } | undefined, adapter: InstalledIdentity | undefined): boolean {
  if (!declaration || !adapter) return false;
  const same = (build: BuildIdentity) => build.version === declaration.version && build.integrity === declaration.integrity;
  return same(adapter) || (adapter.acceptedPriorBuilds ?? []).some(same);
}
