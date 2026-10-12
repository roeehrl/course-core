// Public demo only, serialized through the installed package's SDK adapter.
import { writeFileSync } from "node:fs";
import { motionDemo } from "@course-core/visuals/demos";
import {
  toVisualExperience,
  fromVisualExperience,
} from "@course-core/visuals/headless";
const experience = toVisualExperience(motionDemo);
fromVisualExperience(experience);
writeFileSync(
  new URL("../tests/visual-fixture.json", import.meta.url),
  JSON.stringify(experience, null, 2) + "\n",
);
