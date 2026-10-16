import { describe } from "vitest";
// The native project resolves the app's own modules, never their `.web` variants.
import { PlacementRun } from "../../src/components/PlacementRun";
import { unavailableCases } from "../placementUnavailableCases";

describe("native placement when the first load fails", () => unavailableCases(PlacementRun));
