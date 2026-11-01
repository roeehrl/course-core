import { randomUUID } from "node:crypto";
import { toVisualExperience } from "@course-core/visuals/headless";
import { sortingDemo } from "@course-core/visuals/demos";
import { svgRenderer } from "../../src/svg-renderer.js";
import { fixture } from "../../test/fixture.js";
import type { FixtureContext } from "./index.js";

/**
 * Browser fixtures of the learner AI part "ask" (asking the companion from the lesson): routes
 * named `/test/ask-…`.
 *
 * `/test/ask-session`: a learner enrolled in the public ordering course (no placement) whose first
 * lesson, "Minimum", has its text, then a reviewed YouTube video and an illustration with labelled
 * parts (the sorting scene's bars), published by a workspace owner through the real API. Returns a
 * learner sign-in code.
 */
export async function register(ctx: FixtureContext): Promise<void> {
  const { app, db, hostOrigin: origin, issueLoginCode } = ctx;
  const renderer = await svgRenderer();
  app.post("/test/ask-session", async () => {
    const workspace = randomUUID(), ids: Record<string, string> = {};
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ask-" + workspace, "Ask from lesson workspace"]);
    for (const role of ["owner", "learner"]) {
      ids[role] = randomUUID();
      await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [ids[role], "ask-browser:" + ids[role], role === "owner" ? "Ask owner" : "Ask learner"]);
      await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, ids[role], role]);
    }
    const login = async (id: string) => {
      const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
      return { origin, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": r.json().csrfToken };
    };
    const call = async (url: string, payload: unknown, headers: Record<string, string>) => {
      const r = await app.inject({ method: "POST", url, headers, payload: payload as object });
      if (r.statusCode !== 200) throw Error(`Ask fixture ${url} failed: ${r.body}`);
      return r.json();
    };
    const owner = await login(ids.owner!), learner = await login(ids.learner!);
    const course = fixture(), illustration = toVisualExperience(sortingDemo);
    course.id = "ask-ordering";
    course.placement = { ...course.placement!, enabled: false };
    course.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: "declarative", entrypoint: "renderers/svg-v1.js",
      platforms: ["web"], capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: illustration.accessibility.description } });
    course.visuals.push(illustration);
    course.sources.push({ id: "walkthrough-source", title: "Public walkthrough", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", reviewedAt: "2026-01-01T00:00:00.000Z" });
    course.media.push({ id: "walkthrough", type: "youtube", sourceRef: "walkthrough-source", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", review: "reviewed",
      alternativeMarkdown: "A walkthrough that keeps the smaller value after each comparison.", generated: false });
    course.chapters[0]!.episodes[0]!.blocks.splice(1, 0,
      { id: "min-video", type: "media", mediaId: "walkthrough", required: false },
      { id: "min-visual", type: "visual", visualId: illustration.id });
    const release = (await call(`/api/workspaces/${workspace}/releases`, course, owner)).id;
    await call(`/api/releases/${release}/publish`, {}, owner);
    await call("/api/enrollments", { releaseId: release }, learner);
    return { token: await issueLoginCode(db, ids.learner!) };
  });
}
