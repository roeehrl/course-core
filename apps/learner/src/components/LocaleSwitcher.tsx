import React from "react";
import { Pressable, Text, View } from "react-native";
import { localeInfo, type AppLocale } from "@course-core/i18n";
import { useT } from "../i18n";
import { useLocaleControl } from "../i18n/LocaleProvider";
import { styles } from "./ui";

/** Native language picker: one button per language, named in that language. */
export function LocaleSwitcher({ onChosen }: { onChosen?: (locale: AppLocale) => void }) {
  const t = useT();
  const control = useLocaleControl();
  return (
    <View role="radiogroup" aria-label={t("localeSwitcher.label")}>
      <Text style={styles.body}>{t("localeSwitcher.label")}</Text>
      {control.available.map((locale) => (
        <Pressable
          key={locale}
          role="radio"
          aria-checked={control.locale === locale}
          onPress={() => {
            control.choose(locale);
            onChosen?.(locale);
          }}
        >
          <Text style={[styles.body, { writingDirection: localeInfo(locale).dir }]}>
            {localeInfo(locale).nativeName}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
