import {
  digestTeachingArtifact,
  type TeachingArtifact,
} from "@course-core/sdk";

/** Public toy reference supplied by a creator. It checks all content in a
 * closed grammar; arbitrary prose remains outside this example's qualification. */
export const isolatedOrderingSource = `import re
def solve(payload):
    artifact = payload['artifact']
    match = re.fullmatch(r'Minimum of \\[(-?\\d+(?:, -?\\d+){1,7})\\] is (-?\\d+)\\.', artifact['markdown'])
    passed = False
    if match and artifact['kind'] == 'explanation':
        values = [int(value) for value in match.group(1).split(', ')]
        answer = int(match.group(2))
        limit = payload['referenceData']['absoluteLimit']
        passed = all(abs(value) <= limit for value in values + [answer]) and answer in values and all(answer <= value for value in values)
    return {'minimum-reference': passed}
`;
export async function isolatedOrderingDefinition(
  source = isolatedOrderingSource,
) {
  const artifact = async (
    markdown: string,
    id = "example",
  ): Promise<TeachingArtifact> => {
    const draft = {
      id,
      kind: "explanation" as const,
      markdown,
      objectiveIds: ["minimum"],
      sourceRefs: ["ordering-reference"],
      generator: { id: "isolated-ordering-generator", version: "1.0.0" },
    };
    return { ...draft, digest: await digestTeachingArtifact(draft) };
  };
  const qualification = [];
  for (const [index, [text, passed]] of [
    ["Minimum of [5, -2, 9] is -2.", true],
    ["Minimum of [0, 0, 7] is 0.", true],
    ["Minimum of [5, -2, 9] is 5.", false],
    ["Minimum of [0, 0, 7] is -1.", false],
    ["Minimum of [5, -2, 9] is -2. Everything is mastered.", false],
  ].entries())
    qualification.push({
      id: "case-" + index,
      artifact: await artifact(text as string, "example-" + index),
      expectedChecks: { "minimum-reference": passed as boolean },
    });
  return {
    artifact,
    definition: {
      schemaVersion: 1,
      id: "isolated-ordering-extension",
      adapterId: "isolated-ordering-v1",
      generatorId: "isolated-ordering-generator",
      verifierId: "isolated-ordering-verifier",
      version: "1.0.0",
      artifactKinds: ["explanation"],
      sourceRefs: ["ordering-reference"],
      checkIds: ["minimum-reference"],
      source,
      referenceData: { absoluteLimit: 1000000 },
      qualification,
    },
  };
}
