-- Locale preferences (docs/i18n.md). Additive only: two nullable columns.
--
-- app_users.locale is a person's saved UI language; workspaces.default_locale is the owner's
-- default for members who have saved none and whose browser asks for no supported language.
-- The resolution order is: user preference, then Accept-Language, then workspace default, then
-- English (src/locale.ts). NULL means "no preference". The list of supported locales is not
-- repeated here: the API validates against SUPPORTED_LOCALES in @course-core/i18n, so adding a
-- locale needs no migration. The CHECK only keeps stored values shaped like a language tag.
ALTER TABLE app_users ADD COLUMN locale text
  CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
ALTER TABLE workspaces ADD COLUMN default_locale text
  CHECK (default_locale IS NULL OR default_locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
