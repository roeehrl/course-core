/**
 * A small, explicit unit table for numeric answers. A learner may state a value in any unit of
 * the same kind as the item's unit (mm for m, km/h for m/s, min for s) and the server converts
 * it to the item's unit before the tolerance is applied. Units of a different kind never
 * convert. Temperatures are offset scales, so °C, °F and K only match themselves.
 *
 * Grammar: factors joined by `*`, `·` or a space, at most one `/`, each factor a unit with an
 * optional SI prefix (SI units only) and an optional exponent (`^2`, `²`, `³`). Anything outside
 * the table is not parsed, and the caller falls back to comparing the unit text exactly.
 */
type Dimension = readonly [length: number, mass: number, time: number, current: number, information: number, angle: number];
interface UnitDef { factor: number; dimension: Dimension; prefixable: boolean }
const D = (length = 0, mass = 0, time = 0, current = 0, information = 0, angle = 0): Dimension => [length, mass, time, current, information, angle];
const LENGTH = D(1), MASS = D(0, 1), TIME = D(0, 0, 1);
const UNITS: Record<string, UnitDef> = {
  m: { factor: 1, dimension: LENGTH, prefixable: true },
  in: { factor: 0.0254, dimension: LENGTH, prefixable: false },
  ft: { factor: 0.3048, dimension: LENGTH, prefixable: false },
  yd: { factor: 0.9144, dimension: LENGTH, prefixable: false },
  mi: { factor: 1609.344, dimension: LENGTH, prefixable: false },
  g: { factor: 0.001, dimension: MASS, prefixable: true },
  t: { factor: 1000, dimension: MASS, prefixable: false },
  lb: { factor: 0.45359237, dimension: MASS, prefixable: false },
  oz: { factor: 0.028349523125, dimension: MASS, prefixable: false },
  s: { factor: 1, dimension: TIME, prefixable: true },
  min: { factor: 60, dimension: TIME, prefixable: false },
  h: { factor: 3600, dimension: TIME, prefixable: false },
  d: { factor: 86_400, dimension: TIME, prefixable: false },
  L: { factor: 0.001, dimension: D(3), prefixable: true },
  l: { factor: 0.001, dimension: D(3), prefixable: true },
  Hz: { factor: 1, dimension: D(0, 0, -1), prefixable: true },
  N: { factor: 1, dimension: D(1, 1, -2), prefixable: true },
  J: { factor: 1, dimension: D(2, 1, -2), prefixable: true },
  W: { factor: 1, dimension: D(2, 1, -3), prefixable: true },
  Pa: { factor: 1, dimension: D(-1, 1, -2), prefixable: true },
  A: { factor: 1, dimension: D(0, 0, 0, 1), prefixable: true },
  C: { factor: 1, dimension: D(0, 0, 1, 1), prefixable: true },
  V: { factor: 1, dimension: D(2, 1, -3, -1), prefixable: true },
  'Ω': { factor: 1, dimension: D(2, 1, -3, -2), prefixable: true },
  ohm: { factor: 1, dimension: D(2, 1, -3, -2), prefixable: true },
  B: { factor: 8, dimension: D(0, 0, 0, 0, 1), prefixable: true },
  bit: { factor: 1, dimension: D(0, 0, 0, 0, 1), prefixable: true },
  rad: { factor: 1, dimension: D(0, 0, 0, 0, 0, 1), prefixable: true },
  deg: { factor: Math.PI / 180, dimension: D(0, 0, 0, 0, 0, 1), prefixable: false },
  '°': { factor: Math.PI / 180, dimension: D(0, 0, 0, 0, 0, 1), prefixable: false },
};
const PREFIXES: Record<string, number> = {
  T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, 'µ': 1e-6, 'μ': 1e-6, u: 1e-6, n: 1e-9, p: 1e-12,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
};
const BINARY = new Set(['Ki', 'Mi', 'Gi', 'Ti']);
const SUPERSCRIPT: Record<string, string> = { '²': '2', '³': '3', '⁻': '-', '¹': '1' };
const MAX_FACTORS = 6;

export interface ParsedUnit { factor: number; dimension: Dimension }

function factorOf(token: string): ParsedUnit | null {
  const plain = token.replace(/[²³⁻¹]/gu, c => SUPERSCRIPT[c]!);
  const match = /^([^\^\d-]+)(?:\^?(-?\d))?$/u.exec(plain);
  if (!match) return null;
  const name = match[1]!, power = match[2] === undefined ? 1 : Number(match[2]);
  if (!power || Math.abs(power) > 4) return null;
  let unit: UnitDef | undefined = UNITS[name], scale = 1;
  if (!unit) {
    for (const [prefix, value] of Object.entries(PREFIXES)) {
      const rest = name.slice(prefix.length), base = UNITS[rest];
      // Binary prefixes only name amounts of information.
      // Binary prefixes only name amounts of information, and information takes no fractional prefix (dB is not a byte).
      const information = base?.dimension[4] === 1;
      if (name.startsWith(prefix) && base?.prefixable && (BINARY.has(prefix) ? information : !information || value >= 1000)) { unit = base; scale = value; break; }
    }
  }
  if (!unit) return null;
  return { factor: (unit.factor * scale) ** power, dimension: unit.dimension.map(n => n * power) as unknown as Dimension };
}

/** A unit expression from the table, or null when any part of it is unknown. */
export function parseUnit(text: string): ParsedUnit | null {
  const clean = text.trim().replace(/\s*([*·/])\s*/gu, '$1').replace(/\s+/gu, '*');
  if (!clean || clean.length > 50) return null;
  const halves = clean.split('/');
  if (halves.length > 2) return null;
  const parts = halves.map(half => half.split(/[*·]/u));
  if (parts.flat().length > MAX_FACTORS || parts.flat().some(p => !p)) return null;
  let factor = 1, dimension: number[] = [0, 0, 0, 0, 0, 0];
  for (const [index, half] of parts.entries()) for (const token of half) {
    const parsed = factorOf(token);
    if (!parsed) return null;
    const sign = index === 0 ? 1 : -1;
    factor = sign > 0 ? factor * parsed.factor : factor / parsed.factor;
    dimension = dimension.map((n, i) => n + sign * parsed.dimension[i]!);
  }
  return { factor, dimension: dimension as unknown as Dimension };
}

/** `value` stated in `from`, expressed in `to`; null when either unit is unknown or they measure
 * different kinds of quantity. Rounded to 12 significant digits, so an exact conversion such as
 * 2.54 cm to 1 in compares equal to the key. */
export function convertUnit(value: number, from: string, to: string): number | null {
  const source = parseUnit(from), target = parseUnit(to);
  if (!source || !target || source.dimension.some((n, i) => n !== target.dimension[i])) return null;
  const converted = value * source.factor / target.factor;
  return Number.isFinite(converted) ? Number(converted.toPrecision(12)) : null;
}
