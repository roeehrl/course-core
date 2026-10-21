import React, { useId } from "react";
import { localeInfo, type AppLocale } from "@course-core/i18n";
import { useT } from "../i18n";
import { useLocaleControl } from "../i18n/LocaleProvider";

/** The UI language picker. Each option is the language's own name, in its own direction. */
export function LocaleSwitcher({ onChosen }: { onChosen?: (locale: AppLocale) => void }) {
  const t = useT();
  const control = useLocaleControl();
  const id = useId();
  return (
    <div className="connected-locale-switcher">
      <label htmlFor={id}>{t("localeSwitcher.label")}</label>
      <select
        id={id}
        value={control.locale}
        onChange={(event) => {
          const next = event.target.value as AppLocale;
          control.choose(next);
          onChosen?.(next);
        }}
      >
        {control.available.map((locale) => (
          <option key={locale} value={locale} lang={locale} dir={localeInfo(locale).dir}>
            {localeInfo(locale).nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
