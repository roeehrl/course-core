import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountMenu,
  initials,
  type AccountMenuGroup,
} from "../src/components/AccountMenu";
import { ConnectedHost } from "../src/ConnectedHost";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function menu(onSelect = vi.fn()) {
  const groups: AccountMenuGroup[] = [
    {
      id: "language",
      label: "Language",
      items: [
        {
          kind: "radio",
          id: "en",
          label: "English",
          checked: true,
          onSelect: () => onSelect("en"),
        },
        {
          kind: "radio",
          id: "he",
          label: "עברית",
          lang: "he",
          dir: "rtl",
          checked: false,
          onSelect: () => onSelect("he"),
        },
      ],
    },
    {
      id: "settings",
      items: [
        {
          kind: "action",
          id: "password",
          label: "Change password",
          opensDialog: true,
          onSelect: () => onSelect("password"),
        },
        {
          kind: "action",
          id: "passkeys",
          label: "Passkeys",
          disabled: true,
          onSelect: () => onSelect("passkeys"),
        },
      ],
    },
    {
      id: "session",
      items: [
        {
          kind: "action",
          id: "signOut",
          label: "Sign out",
          onSelect: () => onSelect("signOut"),
        },
      ],
    },
  ];
  render(
    <>
      <AccountMenu name="Dana Levi" detail="dana.levi" groups={groups} />
      <button type="button">Elsewhere</button>
    </>,
  );
  return {
    onSelect,
    button: screen.getByRole("button", { name: "Your account: Dana Levi" }),
  };
}
const focused = () => document.activeElement as HTMLElement;

describe("account menu (menu button pattern)", () => {
  it("shows initials, names the person and is a closed menu button at first", () => {
    expect(initials("Dana Levi")).toBe("DL");
    expect(initials("  maya  ")).toBe("M");
    expect(initials("דנה בן לוי")).toBe("דל");
    expect(initials("")).toBe("");
    const { button } = menu();
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-controls");
    expect(button).toHaveTextContent("DLDana Levi");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on click with focus on the first item, labelled by its button", () => {
    const { button } = menu();
    fireEvent.click(button);
    const list = screen.getByRole("menu");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", list.id);
    expect(list).toHaveAttribute("aria-labelledby", button.id);
    expect(screen.getByRole("group", { name: "Language" })).toBeVisible();
    expect(focused()).toHaveTextContent("English");
    expect(
      screen.getByRole("menuitemradio", { name: "English" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "עברית" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("menuitem", { name: "Change password" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    // Items take focus with the arrow keys, not Tab.
    const items = document.querySelectorAll('[role^="menuitem"]');
    expect(items).toHaveLength(5);
    for (const item of items) expect(item).toHaveAttribute("tabindex", "-1");
  });

  it("moves with the arrow keys, Home, End and a first letter, wrapping at both ends", () => {
    const { button } = menu();
    fireEvent.keyDown(button, { key: "ArrowUp" });
    expect(focused()).toHaveTextContent("Sign out");
    const list = screen.getByRole("menu");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(focused()).toHaveTextContent("English");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(focused()).toHaveTextContent("Sign out");
    fireEvent.keyDown(list, { key: "Home" });
    expect(focused()).toHaveTextContent("English");
    fireEvent.keyDown(list, { key: "End" });
    expect(focused()).toHaveTextContent("Sign out");
    fireEvent.keyDown(list, { key: "c" });
    expect(focused()).toHaveTextContent("Change password");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    // A disabled item can be reached (and is announced as unavailable) but does nothing.
    expect(focused()).toHaveTextContent("Passkeys");
    expect(focused()).toHaveAttribute("aria-disabled", "true");
  });

  it("opens from the keyboard on the first item with Down Arrow", () => {
    const { button } = menu();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(focused()).toHaveTextContent("English");
  });

  it("closes on Escape and Tab and returns focus to the button", () => {
    const { button } = menu();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(focused()).toBe(button);
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focused()).toBe(button);
  });

  it("closes on a click outside without taking focus back", () => {
    const { button } = menu();
    fireEvent.click(button);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.pointerDown(elsewhere);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focused()).toBe(elsewhere);
  });

  it("runs a chosen item after closing with focus on the button; a disabled item does nothing", () => {
    const { button, onSelect } = menu();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "Passkeys" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Change password" }));
    expect(onSelect).toHaveBeenCalledWith("password");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focused()).toBe(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "עברית" }));
    expect(onSelect).toHaveBeenLastCalledWith("he");
  });
});

describe("connected host account dialogs", () => {
  function signedIn(
    handler: (url: string, init?: RequestInit) => Response | undefined = () =>
      undefined,
  ) {
    document.cookie = "course_csrf=csrf-token";
    return stubFetch((url, init) => {
      const answer = handler(url, init);
      if (answer) return answer;
      if (url === "/auth/session")
        return json({
          user: {
            id: "u1",
            displayName: "Dana Levi",
            loginName: "dana.levi",
            hasPassword: true,
          },
        });
      if (url === "/api/workspaces")
        return json([{ id: "w1", title: "Example school", role: "owner" }]);
      if (url === "/api/workspaces/w1/locale")
        return json({ defaultLocale: null, supported: ["en", "he"] });
      if (url === "/api/me/locale")
        return json({ preference: null, locale: "en", source: "request" });
      if (url === "/auth/passkeys")
        return json({ available: true, passkeys: [] });
      return json({ error: "UNAVAILABLE" }, 503);
    });
  }
  async function openFromMenu(name: string) {
    const button = await screen.findByRole("button", {
      name: "Your account: Dana Levi",
    });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("menuitem", { name }));
    return button;
  }

  it("offers every account action in the menu, not as a strip of buttons above the app", async () => {
    signedIn();
    render(
      <LocaleProvider>
        <ConnectedHost />
      </LocaleProvider>,
    );
    const button = await screen.findByRole("button", {
      name: "Your account: Dana Levi",
    });
    // Nothing account-related sits outside the menu.
    for (const name of [
      "Change password",
      "Passkeys",
      "Sign out",
      "Workspace language",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByLabelText("Language")).toBeNull();
    expect(document.querySelector(".connection-bar")).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent?.trim()),
      ).toEqual([
        "Workspace language",
        "Change password",
        "Passkeys",
        "Sign out",
      ]),
    );
  });

  it("opens one dialog at a time; Cancel and Escape close it and focus returns to the menu button", async () => {
    signedIn();
    render(
      <LocaleProvider>
        <ConnectedHost />
      </LocaleProvider>,
    );
    const button = await openFromMenu("Change password");
    const dialog = screen.getByRole("dialog", { name: "Change password" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Current password")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();

    await openFromMenu("Workspace language");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    // A second choice from the menu replaces the open dialog instead of stacking another.
    await openFromMenu("Passkeys");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const passkeys = screen.getByRole("dialog", { name: "Passkeys" });
    expect(
      await screen.findByText("You have no passkeys yet."),
    ).toBeInTheDocument();
    fireEvent(passkeys, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("confirms a changed password in a status message that floats over the page", async () => {
    const changes: unknown[] = [];
    signedIn((url, init) => {
      if (url !== "/auth/password") return undefined;
      changes.push(JSON.parse(String(init?.body)));
      return json({ changed: true });
    });
    render(
      <LocaleProvider>
        <ConnectedHost />
      </LocaleProvider>,
    );
    await openFromMenu("Change password");
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old passphrase here" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "a new passphrase" },
    });
    fireEvent.change(screen.getByLabelText("Repeat new password"), {
      target: { value: "a new passphrase" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Change password", hidden: false }),
    );
    const status = await screen.findByText(
      "Your password was changed. Your other sessions were signed out.",
    );
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(status.closest(".toast-region")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(changes).toEqual([
      {
        currentPassword: "old passphrase here",
        newPassword: "a new passphrase",
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Close this message" }));
    expect(
      screen.queryByText(
        "Your password was changed. Your other sessions were signed out.",
      ),
    ).toBeNull();
  });

  it("does not close the password dialog while the change is being saved", async () => {
    let finish: (response: Response) => void = () => {};
    signedIn((url) =>
      url === "/auth/password"
        ? (new Promise<Response>((resolve) => {
            finish = resolve;
          }) as unknown as Response)
        : undefined,
    );
    render(
      <LocaleProvider>
        <ConnectedHost />
      </LocaleProvider>,
    );
    await openFromMenu("Change password");
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old passphrase here" },
    });
    for (const label of ["New password", "Repeat new password"])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "a new passphrase" },
      });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("button", { name: "Saving…" });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => finish(json({ changed: true })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reports a failed sign-out as an alert and stays signed in", async () => {
    signedIn((url) =>
      url === "/auth/logout" ? json({ error: "UNAVAILABLE" }, 503) : undefined,
    );
    render(
      <LocaleProvider>
        <ConnectedHost />
      </LocaleProvider>,
    );
    await openFromMenu("Sign out");
    const alert = await screen.findByText(
      "Sign-out failed. Retry when the connection is available.",
    );
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Your account: Dana Levi" }),
    ).toBeInTheDocument();
  });
});
