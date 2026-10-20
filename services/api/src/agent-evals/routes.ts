import type { FastifyInstance } from "fastify";
import type { authService } from "../auth.js";
import type { ProviderEvaluations } from "./gate.js";

/** Agent evaluation status, recorded results and owner overrides for one workspace. */
export function registerProviderEvalRoutes(app: FastifyInstance, auth: ReturnType<typeof authService>, service: ProviderEvaluations) {
  const base = "/api/admin/workspaces/:workspaceId/provider-evals",
    params = { type: "object", additionalProperties: false, required: ["workspaceId"], properties: { workspaceId: { type: "string", format: "uuid" } } };
  const workspace = (request: { params: unknown }) => (request.params as { workspaceId: string }).workspaceId;
  app.get(base, { schema: { params }, logLevel: "silent" }, async (request) => service.status(await auth.authenticate(request), workspace(request)));
  app.post(base + "/results", { schema: { params }, bodyLimit: 1_000_000, logLevel: "silent" },
    async (request) => service.record(await auth.authenticate(request), workspace(request), request.body));
  app.post(base + "/overrides", { schema: { params }, bodyLimit: 8192, logLevel: "silent" },
    async (request) => service.override(await auth.authenticate(request), workspace(request), request.body));
}
