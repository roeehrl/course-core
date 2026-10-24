import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditableSnapshot } from "../src/hooks/useEditableSnapshot";

describe("editable snapshot (learner forms)", () => {
  it("follows the saved value until edited, keeps the edit over a reload and names a newer version", () => {
    const hook = renderHook(({ saved }) => useEditableSnapshot(saved), { initialProps: { saved: [1, 3] } });
    hook.rerender({ saved: [1, 3, 5] });
    expect(hook.result.current.value).toEqual([1, 3, 5]);
    act(() => hook.result.current.set((days) => [...days, 0]));
    hook.rerender({ saved: [1, 3, 5] });
    expect(hook.result.current.changedElsewhere).toBe(false);
    hook.rerender({ saved: [2] });
    expect(hook.result.current.value).toEqual([1, 3, 5, 0]);
    expect(hook.result.current.changedElsewhere).toBe(true);
    act(() => hook.result.current.keep());
    expect(hook.result.current.changedElsewhere).toBe(false);
    act(() => hook.result.current.settle());
    hook.rerender({ saved: [0, 1, 3, 5] });
    expect(hook.result.current.value).toEqual([0, 1, 3, 5]);
    expect(hook.result.current.edited).toBe(false);
  });
});
