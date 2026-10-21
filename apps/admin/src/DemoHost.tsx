import { useMemo, useState } from "react";
import { AdminApp } from "./AdminApp";
import { createDemoAdminClient, type DemoScenario } from "./client/demoClient";
import type { DemoRole } from "./data/fixtures";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { useT } from "./i18n";

/** Demo controls are never included by AdminApp or the connected fetch client. */
export function DemoHost() {
  const t = useT();
  const [role, setRole] = useState<DemoRole>("administrator");
  const [scenario, setScenario] = useState<DemoScenario>("standard");
  const client = useMemo(
    () => createDemoAdminClient({ role, scenario }),
    [role, scenario],
  );
  return (
    <>
      <div className="demo-toolbar" aria-label={t("demoHost.controls")}>
        <strong>{t("demoHost.title")}</strong>
        <label htmlFor="demo-role">
          {t("demoHost.role")}{" "}
          <select
            id="demo-role"
            value={role}
            onChange={(e) => setRole(e.target.value as DemoRole)}
          >
            <option value="administrator">
              {t("demoHost.roles.administrator")}
            </option>
            <option value="reviewer">{t("demoHost.roles.reviewer")}</option>
            <option value="observer">{t("demoHost.roles.observer")}</option>
          </select>
        </label>
        <label htmlFor="demo-scenario">
          {t("demoHost.scenario")}{" "}
          <select
            id="demo-scenario"
            value={scenario}
            onChange={(e) => setScenario(e.target.value as DemoScenario)}
          >
            <option value="standard">{t("demoHost.scenarios.standard")}</option>
            <option value="permission_denied">
              {t("demoHost.scenarios.permissionDenied")}
            </option>
            <option value="stale_revision">
              {t("demoHost.scenarios.staleRevision")}
            </option>
            <option value="load_failure">
              {t("demoHost.scenarios.loadFailure")}
            </option>
          </select>
        </label>
        <small>{t("demoHost.resetNote")}</small>
        <LocaleSwitcher />
      </div>
      <AdminApp key={`${role}:${scenario}`} client={client} />
    </>
  );
}
