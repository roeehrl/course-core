import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
afterEach(cleanup);
window.scrollTo = vi.fn();
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
  this.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
// Every test starts at the app's own address with no remembered course (routing.ts keeps the
// page in the address and the last course in local storage, which outlive one test).
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  try {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith("course-core.admin.last-course"))
        window.localStorage.removeItem(key);
  } catch {
    // No storage: nothing to forget.
  }
});
