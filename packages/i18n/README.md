# @course-core/i18n

Locales, typed message catalogs, an ICU MessageFormat subset, `Intl` formatting, bidi helpers
and React bindings shared by the admin app, the learner app (React Native and web) and the API.
It has no runtime dependencies; React is an optional peer used only by `@course-core/i18n/react`.

The supported locale list (`SUPPORTED_LOCALES`), the fallback order and every convention are
documented in [docs/i18n.md](../../docs/i18n.md).

```sh
npm ci --ignore-scripts
npm run typecheck
npm test        # node --test on the TypeScript sources (Node 26 type stripping)
npm run build   # dist/ for the apps and the API
```

Sources import each other with `.ts` extensions (`rewriteRelativeImportExtensions`), so Node can
run them directly: the root check script `scripts/i18n-check.mjs` reads the locale list and the
message parser from `src/` without a build.
