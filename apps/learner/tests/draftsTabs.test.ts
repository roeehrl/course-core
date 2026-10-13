import { describe, expect, it } from "vitest";
import { createConnectedDraftStore } from "../src/connected/drafts";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}
describe("drafts across two tabs of one account", () => {
  it("a write in one tab never erases a draft another tab saved", () => {
    const storage = memoryStorage();
    const a = createConnectedDraftStore("acct", storage), b = createConnectedDraftStore("acct", storage);
    a.write("e1:answer:c1", "first tab draft");
    b.write("e2:answer:c2", "second tab draft");
    a.write("e1:answer:c1", "first tab edited");
    const fresh = createConnectedDraftStore("acct", storage);
    expect(fresh.read("e1:answer:c1")).toBe("first tab edited");
    expect(fresh.read("e2:answer:c2")).toBe("second tab draft");
  });
  it("picks up another tab's drafts from the storage event", () => {
    const storage = memoryStorage();
    const a = createConnectedDraftStore("acct", storage), b = createConnectedDraftStore("acct", storage);
    let calls = 0;
    const stop = a.subscribe(() => calls++);
    b.write("e3:answer:c3", "written elsewhere");
    window.dispatchEvent(new StorageEvent("storage", { key: "course:learner-drafts:acct" }));
    expect(a.read("e3:answer:c3")).toBe("written elsewhere");
    expect(calls).toBe(1);
    stop();
  });
});
