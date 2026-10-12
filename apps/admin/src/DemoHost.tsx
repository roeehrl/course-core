import { useMemo, useState } from "react";
import { AdminApp } from "./AdminApp";
import { createDemoAdminClient, type DemoScenario } from "./client/demoClient";
import type { DemoRole } from "./data/fixtures";

/** Demo controls are never included by AdminApp or the connected fetch client. */
export function DemoHost() {
  const [role, setRole] = useState<DemoRole>("administrator");
  const [scenario, setScenario] = useState<DemoScenario>("standard");
  const client = useMemo(
    () => createDemoAdminClient({ role, scenario }),
    [role, scenario],
  );
  return (
    <>
      <div className="demo-toolbar" aria-label="Demo controls">
        <strong>Interactive demo</strong>
        <label htmlFor="demo-role">
          Role{" "}
          <select
            id="demo-role"
            value={role}
            onChange={(e) => setRole(e.target.value as DemoRole)}
          >
            <option value="administrator">Administrator</option>
            <option value="reviewer">Reviewer</option>
            <option value="observer">Observer</option>
          </select>
        </label>
        <label htmlFor="demo-scenario">
          Scenario{" "}
          <select
            id="demo-scenario"
            value={scenario}
            onChange={(e) => setScenario(e.target.value as DemoScenario)}
          >
            <option value="standard">Standard</option>
            <option value="permission_denied">Permission denied</option>
            <option value="stale_revision">Stale next update</option>
            <option value="load_failure">Loading failure</option>
          </select>
        </label>
        <small>Changing a demo control resets the fictional workspace.</small>
      </div>
      <AdminApp key={`${role}:${scenario}`} client={client} />
    </>
  );
}
