import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// After `waitFor` or `findBy*` resolves, the render it saw may still have its passive effects
// pending, and a react-native-web button pressed with a synchronous `fireEvent.click` then can reach
// its previous `disabled` and `onPress` (see pressWhenReady.ts). Such a press goes through
// `pressWhenReady`. user-event presses are not flagged: `userEvent.click` waits for a timer before
// it presses, and React's scheduler (a setImmediate in Node) gets a turn before any timer fires.
// The admin is not checked: it renders DOM buttons, whose `disabled` and handlers change in the
// commit itself.

const WAIT = /^(waitFor|find(All)?By[A-Z]\w*)$/;
const PRESS = new Set(["click", "press", "dblClick"]);

type Finding = { line: number; press: string };

function calleeName(call: ts.CallExpression): { name?: string; object?: string } {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return { name: callee.text };
  if (ts.isPropertyAccessExpression(callee))
    return { name: callee.name.text, object: ts.isIdentifier(callee.expression) ? callee.expression.text : undefined };
  return {};
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression) || ts.isNonNullExpression(expression))
    expression = expression.expression;
  return expression;
}

/** Synchronous presses that directly follow an awaited `waitFor`/`findBy*` (or a local helper that
 * returns one) in the same statement list, with no other await in between. */
function pressesAfterWait(source: string, fileName = "test.tsx"): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // `const enabled = (name) => waitFor(...)` waits too.
  const helpers = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer)) {
      const body = node.initializer.body;
      const result = ts.isBlock(body) ? body.statements.find(ts.isReturnStatement)?.expression : body;
      const call = result && unwrap(result);
      if (call && ts.isCallExpression(call) && WAIT.test(calleeName(call).name ?? "")) helpers.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const isWait = (expression: ts.Expression) => {
    const call = unwrap(expression);
    const name = ts.isCallExpression(call) ? calleeName(call).name : undefined;
    return !!name && (WAIT.test(name) || helpers.has(name));
  };
  const isPress = (call: ts.CallExpression) => {
    const { name, object } = calleeName(call);
    return object === "fireEvent" && !!name && PRESS.has(name);
  };
  const found: Finding[] = [];
  // Statements are checked in evaluation order (arguments and awaited operands first). A nested block
  // continues from the statement before it; a callback starts afresh, as it runs at its own time,
  // except one passed to `act`, which runs at once: a press inside `act` is still a press.
  type Last = "wait" | "other" | "press" | undefined;
  const list = (nodes: readonly ts.Node[], start: Last = undefined): Last => {
    let last = start;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) {
        const body = (node as ts.FunctionLikeDeclaration).body;
        if (body) list(ts.isBlock(body) ? body.statements : [body]);
        return;
      }
      if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        last = list(node.statements, last);
        return;
      }
      const callback = ts.isCallExpression(node) && calleeName(node).name === "act" ? node.arguments[0] : undefined;
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        last = list(ts.isBlock(callback.body) ? callback.body.statements : [callback.body], last);
        return;
      }
      ts.forEachChild(node, visit);
      if (ts.isAwaitExpression(node)) last = isWait(node.expression) ? "wait" : "other";
      else if (ts.isCallExpression(node) && isPress(node)) {
        if (last === "wait")
          found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, press: node.getText().split("\n")[0]! });
        last = "press";
      }
    };
    nodes.forEach(visit);
    return last;
  };
  list(file.statements);
  return found;
}

const tests = dirname(fileURLToPath(import.meta.url));

function unitTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return unitTestFiles(path);
    // Playwright specs drive a real browser, whose clicks wait for the page to settle.
    return /\.(m?ts|tsx)$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [path] : [];
  });
}

const lines = (source: string) => pressesAfterWait(source).map((finding) => finding.line);

describe("presses after waitFor or findBy", () => {
  it("finds a click right after waitFor, findBy and a local waitFor helper", () => {
    expect(lines(`it("x", async () => {
      await waitFor(() => expect(save).toBeEnabled());
      fireEvent.click(save);
    });`)).toEqual([3]);
    expect(lines(`it("x", async () => {
      expect(await screen.findByText(/could not be saved/)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });`)).toEqual([3]);
    expect(lines(`it("x", async () => {
      fireEvent.click(await within(card).findByRole("button", { name: "Retry" }));
    });`)).toEqual([2]);
    expect(lines(`it("x", async () => {
      const enabled = (name) => waitFor(() => { const b = screen.getByRole("button", { name }); expect(b).toBeEnabled(); return b; });
      fireEvent.click(await enabled("Save"));
    });`)).toEqual([3]);
    expect(lines(`it("x", async () => {
      const button = await screen.findByRole("button");
      fireEvent.press(button);
    });`)).toEqual([3]);
  });

  it("finds a click after waitFor inside a nested block and only the first of a run", () => {
    expect(lines(`it("x", async () => {
      for (const day of days) {
        await waitFor(() => expect(box).toBeEnabled());
        fireEvent.click(box);
        fireEvent.click(other);
      }
    });`)).toEqual([4]);
  });

  it("allows pressWhenReady, act, user-event, other awaits and presses before any wait", () => {
    expect(lines(`it("x", async () => {
      fireEvent.click(first);
      await waitFor(() => expect(save).toBeEnabled());
      await pressWhenReady(save);
      fireEvent.click(again);
      await pressWhenReady(await screen.findByRole("button"));
      await waitFor(() => expect(x).toBe(1));
      await act(async () => resolve());
      fireEvent.click(save);
      expect(await screen.findByText("Saved")).toBeVisible();
      await userEvent.click(save);
      await waitFor(() => expect(x).toBe(2));
      await client.reload();
      fireEvent.click(save);
      await waitFor(() => expect(x).toBe(3));
      fireEvent.change(field, { target: { value: "4" } });
    });`)).toEqual([]);
  });

  it("finds a click wrapped in act or in an if block right after a wait", () => {
    expect(lines(`it("x", async () => {
      await waitFor(() => expect(save).toBeEnabled());
      await act(async () => fireEvent.click(save));
      expect(await screen.findByText("Saved")).toBeVisible();
      if (again) {
        fireEvent.click(save);
      }
    });`)).toEqual([3, 6]);
  });

  it("does not carry a wait into a callback or out of one", () => {
    expect(lines(`it("x", async () => {
      await waitFor(() => expect(x).toBe(1));
      const later = () => fireEvent.click(save);
      await act(async () => { await waitFor(() => expect(x).toBe(2)); });
      fireEvent.click(save);
    });`)).toEqual([]);
  });

  it("are pressed through pressWhenReady in every learner unit test", () => {
    const offending = unitTestFiles(tests).flatMap((path) =>
      pressesAfterWait(readFileSync(path, "utf8"), path).map(({ line, press }) => `${relative(tests, path)}:${line}: ${press}`),
    );
    expect(offending, "Press these with `await pressWhenReady(element)` from ./pressWhenReady").toEqual([]);
  });
});
