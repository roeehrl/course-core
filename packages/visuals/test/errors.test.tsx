import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { assertSceneChecks, runSceneChecks } from "../src/checks.js";
import { motionStudyDemo, primitivesDemo } from "../src/demos.js";
import {
  catalogText,
  englishErrorMessages,
  errorText,
  VisualCatalogError,
} from "../src/errors.js";
import type { ErrorKey } from "../src/errors.js";
import { evaluate, finite, VisualError } from "../src/expression.js";
import { sanitizeMarkup } from "../src/markup.js";
import { englishVisualMessages, visualMessages } from "../src/messages.js";
import type { DescribableError } from "../src/messages.js";
import { VisualInspector } from "../src/react.js";
import { VisualRuntime } from "../src/runtime.js";
import { parseScene } from "../src/schema.js";
import { toVisualExperience } from "../src/sdk.js";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The catalog error a call throws: its code, key, params and English message. */
function caught(run: () => unknown): VisualCatalogError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof VisualCatalogError, String(error));
    assert.ok(error instanceof VisualError);
    return error;
  }
  assert.fail("expected a VisualCatalogError");
}
function expectError(
  run: () => unknown,
  code: string,
  key: ErrorKey,
  params: Record<string, string | number>,
  message: string,
) {
  const error = caught(run);
  assert.equal(error.code, code);
  assert.equal(error.key, key);
  assert.deepEqual({ ...error.params }, params);
  assert.equal(error.message, message);
  // The English text is the catalog's: a host translating the key sees the same parameters.
  assert.equal(
    (englishErrorMessages[key] as (p: typeof params) => string)(params),
    message,
  );
}

test("diagnostics carry a stable code, a catalog key and parameters, with unchanged English", () => {
  expectError(
    () => parseScene("{"),
    "JSON",
    "invalidSceneJson",
    {},
    "Invalid scene JSON",
  );
  expectError(
    () => finite(Infinity, "width"),
    "NON_FINITE",
    "nonFinite",
    { label: "width", max: 1_000_000_000 },
    "width must be finite and within ±1000000000",
  );
  expectError(
    () =>
      evaluate(
        { state: "missing" },
        { state: {}, timeMs: 0, seed: 1, tick: 0 },
      ),
    "STATE",
    "unknownState",
    { state: "missing" },
    "Unknown state: missing",
  );
  expectError(
    () =>
      evaluate(
        { op: "div", args: [1, 0] },
        { state: {}, timeMs: 0, seed: 1, tick: 0 },
      ),
    "DIV_ZERO",
    "divisionByZero",
    {},
    "Division by zero",
  );
  expectError(
    () => sanitizeMarkup({ tag: "script", attrs: {}, children: [] }),
    "SANITIZE",
    "markupTreeNotAllowed",
    { tag: "script" },
    "A script tree is not allowed",
  );
  const duplicate = clone(primitivesDemo) as { nodes: { id: string }[] };
  duplicate.nodes.push(clone(duplicate.nodes[0]!));
  expectError(
    () => parseScene(duplicate),
    "SCHEMA",
    "duplicateNode",
    { node: duplicate.nodes[0]!.id },
    `Duplicate node ${duplicate.nodes[0]!.id}`,
  );
  const badId = clone(primitivesDemo) as { id: string };
  badId.id = "Not_An_SDK_Id";
  expectError(
    () => toVisualExperience(badId),
    "SDK_IDENTIFIER",
    "sdkIdentifier",
    {},
    "Scene and reference-check identifiers must use the released SDK identifier grammar.",
  );
});

test("check failures and reference-check results carry their catalog key", () => {
  const drift = clone(motionStudyDemo) as typeof motionStudyDemo & {
    nodes: { children: { height: number }[] }[];
  };
  drift.nodes[1]!.children[0]!.height = 61;
  const failure = runSceneChecks(parseScene(drift))[0]!;
  assert.equal(failure.key, "goldenDiffers");
  assert.equal(
    failure.message,
    errorText(
      "goldenDiffers",
      failure.params as { digest: string; golden: string },
    ),
  );
  const error = caught(() => assertSceneChecks(parseScene(drift)));
  assert.equal(error.key, "sceneCheckFailed");
  assert.equal(error.params.message, failure.message);
  const scene = {
    ...clone(primitivesDemo),
    referenceChecks: ["missing-check"],
  };
  const [result] = new VisualRuntime(parseScene(scene)).runReferenceChecks();
  assert.deepEqual(result, {
    id: "missing-check",
    passed: false,
    ...catalogText("referenceCheckNotRegistered"),
  });
  assert.equal(result!.message, "Reference check is not registered");
});

test("hosts translate errors through describeError; English is the default", () => {
  const error = caught(() => parseScene("{"));
  assert.equal(
    englishVisualMessages.describeError(error),
    "Invalid scene JSON",
  );
  const hebrew: Partial<Record<ErrorKey, string>> = {
    invalidSceneJson: "נתוני הסצנה אינם JSON תקין",
  };
  const describeError = (e: DescribableError) =>
    (e.key && hebrew[e.key as ErrorKey]) ?? e.message;
  const messages = visualMessages({ describeError });
  assert.equal(messages.describeError(error), "נתוני הסצנה אינם JSON תקין");
  // An error without a translation (or without a key) falls back to its English message.
  assert.equal(messages.describeError(new Error("plain")), "plain");
  // The inspector's property rows are host messages too.
  const html = renderToStaticMarkup(
    <VisualInspector
      runtime={new VisualRuntime(motionStudyDemo)}
      messages={{ visibleProperty: "גלוי", boundsProperty: "גבולות" }}
    />,
  );
  assert.match(html, /<th scope="row">גלוי<\/th>/);
  assert.match(html, /<th scope="row">גבולות<\/th>/);
  assert.match(
    renderToStaticMarkup(
      <VisualInspector runtime={new VisualRuntime(motionStudyDemo)} />,
    ),
    /<th scope="row">visible<\/th>/,
  );
});

test("no diagnostic text is written outside the catalog", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    // A VisualError built with a literal message bypasses the catalog (parse issues joined
    // from zod are the one dynamic message, built from catalog texts).
    assert.doesNotMatch(
      source,
      /new VisualError\(\s*["'`][A-Z_]+["'`],\s*["'`]/,
      file,
    );
  }
});
