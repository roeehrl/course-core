/** Semantic-version precedence for course versions (MAJOR.MINOR.PATCH[-pre]; build metadata
 * ignored), matching the server's rule. Returns null when either value is not a version. */
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION.exec(a),
    y = VERSION.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split("."),
    q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const np = /^\d+$/.test(p[i]!),
      nq = /^\d+$/.test(q[i]!);
    if (np && nq) {
      const d = Number(p[i]) - Number(q[i]);
      if (d) return Math.sign(d);
    } else if (np !== nq) return np ? -1 : 1;
    else if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}
/** The newest of `versions` that `version` is lower than, or null when it is not going back. */
export function newerVersion(
  version: string,
  versions: readonly string[],
): string | null {
  let newest: string | null = null;
  for (const other of versions)
    if (
      (compareVersions(version, other) ?? 1) <= 0 &&
      (newest === null || (compareVersions(other, newest) ?? -1) > 0)
    )
      newest = other;
  return newest;
}
