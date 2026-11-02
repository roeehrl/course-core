import React from "react";
import { vi } from "vitest";
import type { Challenge, Question } from "../src/client/apiClient";
import { CheckCard, type CheckCardProps } from "../src/connected/checks/CheckCard.web";
import type { CheckAttempt, CheckCommands } from "../src/connected/checks/useCheckCommands";
import { connectedSnapshot } from "./connectedFixtures";

/** An open question of the fixture lesson ("intro"). */
export function question(overrides: Partial<Question> = {}, challenge: Partial<Challenge> = {}): Challenge {
  return {
    challengeId: "c1",
    episodeId: "intro",
    independentEligible: true,
    mode: "independent",
    question: { id: "q1", type: "numeric", prompt: "With w = 2 and x = 6, what is $w \\cdot x$?", ...overrides } as Question,
    ...challenge,
  };
}

/** The check card of the fixture lesson with every part read, and spies for its commands. */
export function cardProps(open?: Challenge, check: Partial<CheckCommands> = {}): CheckCardProps & { check: CheckCommands } {
  const server = connectedSnapshot();
  server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
  server.activeChallenges = open ? [open] : [];
  return {
    server,
    episode: server.course.chapters[0]!.episodes[0]!,
    ...(open ? { challenge: open } : {}),
    gate: server.lessons[0]!.gate ?? null,
    placement: false,
    pending: false,
    now: Date.now(),
    answer: "",
    onAnswerChange: vi.fn(),
    check: { onStart: vi.fn(), onAnswer: vi.fn(), onAbstain: vi.fn(), onSolution: vi.fn(), onRetry: vi.fn(), ...check },
    waitingForReading: false,
    questionsLeft: 2,
    questionsTotal: 2,
    lastPart: 1,
    blockedMedia: false,
    onRefresh: vi.fn(),
  };
}

/** The last answer kept for the lesson, as useCheckCommands keeps it once the server answered. */
export function answered(challenge: Challenge, result: Record<string, unknown>, answer = "9"): Record<string, CheckAttempt> {
  return {
    [challenge.episodeId]: {
      challenge,
      answer,
      kind: result.abstained ? "abstain" : "answer",
      status: "answered",
      receipt: { result: { independent: challenge.independentEligible, ...result } },
    },
  };
}

export const Card = (props: CheckCardProps) => <CheckCard {...props} />;
