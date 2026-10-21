/** Author reference answers for the items Core cannot grade from the manifest alone: Python code
 * tasks (graded by the host's sandboxed fixture registry) and written role-plays (decided by a
 * human reviewer who quotes the learner). Used by the tests and the real HTTP gate only. */

const linear = `def solve(data):
    values, target = data["values"], data["target"]
    for position, value in enumerate(values):
        if value == target:
            return position
    return -1
`;
const midpoints = `def solve(data):
    values, target = data["values"], data["target"]
    low, high, checked = 0, len(values) - 1, []
    while low <= high:
        middle = (low + high) // 2
        checked.append(middle)
        if values[middle] == target:
            break
        if values[middle] < target:
            low = middle + 1
        else:
            high = middle - 1
    return checked
`;
const lowerBound = `def solve(data):
    values, target = data["values"], data["target"]
    low, high = 0, len(values)
    while low < high:
        middle = (low + high) // 2
        if values[middle] < target:
            low = middle + 1
        else:
            high = middle
    return low
`;
const countRange = `def solve(data):
    return sum(1 for value in data["values"] if data["low"] <= value <= data["high"])
`;
/** Each wrong program fails at least one hidden case for a stated reason. */
export const code = {
  'code-linear': { correct: linear, wrong: 'def solve(data):\n    return 0 if data["values"] and data["values"][0] == data["target"] else -1\n' },
  'code-midpoints': { correct: midpoints, wrong: 'def solve(data):\n    return [len(data["values"]) // 2]\n' },
  'code-lower-bound': { correct: lowerBound, wrong: 'def solve(data):\n    values = data["values"]\n    return values.index(data["target"]) if data["target"] in values else -1\n' },
  'code-count-range': { correct: countRange, wrong: 'def solve(data):\n    return data["high"] - data["low"] + 1\n' },
};

/** A complete role-play and a weak one per scenario, with the reviewer's quotes (verbatim spans). */
const roleplay = (lines, quotes) => ({ response: lines.join('\n'), quotes });
const weak = roleplay(['Hola, hola, muy bien.', 'Sí, sí, de acuerdo.'], { greets: 'Hola, hola, muy bien.' });
export const roleplays = {
  'sg-roleplay-dialogue-1': {
    good: roleplay(['¡Buenos días, señora!', 'Me llamo Laura Pérez.', 'Muchas gracias por el pedido.', 'Adiós, hasta luego.'],
      { greets: '¡Buenos días, señora!', name: 'Me llamo Laura Pérez.', thanks: 'Muchas gracias por el pedido.', farewell: 'Adiós, hasta luego.' }),
    weak,
  },
  'sg-roleplay-dialogue-2': {
    good: roleplay(['Buenas tardes, Marta.', 'Soy Tomás, del cuarto piso.', 'Gracias, mucho gusto.', '¿Y usted, de dónde es?', 'Hasta mañana, Marta.'],
      { greets: 'Buenas tardes, Marta.', name: 'Soy Tomás, del cuarto piso.', thanks: 'Gracias, mucho gusto.', farewell: 'Hasta mañana, Marta.', question: '¿Y usted, de dónde es?' }),
    weak,
  },
  'sg-roleplay-dialogue-3': {
    good: roleplay(['Buenas tardes.', 'Me llamo Irene Gómez.', 'Muchas gracias por la tarjeta.', 'Adiós, buenas tardes.'],
      { greets: 'Buenas tardes.', name: 'Me llamo Irene Gómez.', thanks: 'Muchas gracias por la tarjeta.', farewell: 'Adiós, buenas tardes.' }),
    weak,
  },
  'sg-roleplay-dialogue-4': {
    good: roleplay(['¡Hola, Daniel!', 'Me llamo Nora. ¿Qué tal?', 'Muchas gracias por el bolígrafo.', '¡Hasta luego, Daniel!'],
      { greets: '¡Hola, Daniel!', name: 'Me llamo Nora.', thanks: 'Muchas gracias por el bolígrafo.', farewell: '¡Hasta luego, Daniel!' }),
    weak,
  },
};

/** The reviewer's findings: every criterion, a quote for each met one, a note for each other. */
export function reviewFindings(rubric, quotes) {
  return rubric.map(criterion => quotes[criterion.id]
    ? { criterionId: criterion.id, met: true, quote: quotes[criterion.id] }
    : { criterionId: criterion.id, met: false, note: 'Not found in the learner text yet.' });
}
