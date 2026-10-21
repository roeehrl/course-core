import { describe, expect, it } from "vitest";
import { NEEDED_ROLES, suggestModel } from "../src/provider-suggestions.js";

const model = (remoteModel: string, methods: string[]) => ({
  remoteModel,
  displayName: remoteModel,
  description: "",
  inputTokenLimit: null,
  outputTokenLimit: null,
  methods,
});
const listed = (...ids: string[]) => ({
  models: ids.map((remoteModel) => model(remoteModel, ["generateContent", "messages", "structured_outputs", "web_search"])),
});

describe("model suggestions", () => {
  it("picks the newest stable Google flash model for the tutor and planner, never lite or previews", () => {
    const catalog = listed("gemini-8.0-flash", "gemini-9.0-flash-lite", "gemini-9.5-flash-preview-05", "gemini-9.0-flash", "gemini-9.0-flash-image", "gemini-flash-latest");
    expect(suggestModel("google", "companion", catalog, "generateContent")).toBe("gemini-9.0-flash");
    expect(suggestModel("google", "supervisor", catalog, "generateContent")).toBe("gemini-9.0-flash");
    expect(suggestModel("google", "research", catalog, "generateContent")).toBe("gemini-9.0-flash");
  });
  it("uses Pro for review drafts and nothing for media", () => {
    const catalog = listed("gemini-9.0-pro-preview", "gemini-8.5-pro", "gemini-9.0-flash");
    expect(suggestModel("google", "reviewer", catalog, "generateContent")).toBe("gemini-8.5-pro");
    expect(suggestModel("google", "media", catalog, "generateContent")).toBeNull();
  });
  it("follows the Anthropic families and requires the job's method", () => {
    const catalog = listed("claude-sonnet-8-1", "claude-sonnet-9", "claude-haiku-9", "claude-opus-9");
    expect(suggestModel("anthropic", "companion", catalog, "messages")).toBe("claude-sonnet-9");
    expect(suggestModel("anthropic", "research", catalog, "web_search")).toBe("claude-haiku-9");
    expect(suggestModel("anthropic", "companion", { models: [model("claude-sonnet-9", [])] }, "messages")).toBeNull();
  });
  it("suggests nothing when no listed model matches", () => {
    expect(suggestModel("google", "companion", listed("public-text-model"), "generateContent")).toBeNull();
    expect(suggestModel("unknown", "companion", listed("gemini-9.0-flash"), "generateContent")).toBeNull();
    expect(NEEDED_ROLES).toEqual(["companion", "supervisor"]);
  });
});
