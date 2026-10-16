import { describe } from "vitest";
import { PlacementRun } from "../src/components/PlacementRun.web";
import { unavailableCases } from "./placementUnavailableCases";

describe("web placement when the first load fails", () => unavailableCases(PlacementRun));
