import React from "react";
import { Text } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "../../src/i18n/LocaleProvider";
import { LocaleSwitcher } from "../../src/components/LocaleSwitcher";
import { useI18n } from "../../src/i18n";

function Probe() {
  const { dir, t } = useI18n();
  return <Text testID="probe">{`${dir}:${t("localeSwitcher.label")}`}</Text>;
}

describe("native locale direction", () => {
  it("sets direction on the root view instead of restarting the app", () => {
    render(
      <LocaleProvider>
        <LocaleSwitcher />
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("ltr:Language");
    fireEvent.click(screen.getByRole("radio", { name: "עברית" }));
    expect(screen.getByTestId("probe")).toHaveTextContent("rtl:שפה");
    expect(screen.getByRole("radio", { name: "עברית" })).toHaveAttribute("aria-checked", "true");
    // react-native-web renders the root View's `direction` style as CSS direction.
    expect(screen.getByRole("radiogroup").parentElement).toHaveStyle({ direction: "rtl" });
  });
});
