import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operator controls (approval / question buttons): authorization against
 * channels.max.allowFrom, resolution through the gateway runtimes and the
 * keyboard-replacing callback answer. Gateway runtimes are mocked.
 */

const resolveApproval = vi.hoisted(() => vi.fn(async () => ({ applied: true })));
const resolveQuestion = vi.hoisted(() => vi.fn(async () => ({ status: "answered" as const })));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolveApproval,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: resolveQuestion },
}));

import {
  isMaxRuntimeControlSender,
  resolveMaxRuntimeControlCallback,
} from "./runtime-controls.js";

const baseParams = () => ({
  cfg: {} as any,
  accountId: "default",
  senderId: "42",
  allowFrom: ["42"],
  sourceText: "Запустить деплой?",
  answerCallback: vi.fn(async () => {}),
  log: { warn: vi.fn(), error: vi.fn() },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isMaxRuntimeControlSender", () => {
  it("requires an explicit allowFrom entry for approvals, wildcard is not enough", () => {
    expect(isMaxRuntimeControlSender(["42"], "42", "approval")).toBe(true);
    expect(isMaxRuntimeControlSender(["*"], "42", "approval")).toBe(false);
    expect(isMaxRuntimeControlSender([], "42", "approval")).toBe(false);
  });

  it("accepts a wildcard for questions", () => {
    expect(isMaxRuntimeControlSender(["*"], "42", "question")).toBe(true);
    expect(isMaxRuntimeControlSender(["max:42"], "42", "question")).toBe(true);
    expect(isMaxRuntimeControlSender(["7"], "42", "question")).toBe(false);
  });
});

describe("resolveMaxRuntimeControlCallback", () => {
  it("resolves an approval and replaces the keyboard message with a status line", async () => {
    const params = baseParams();
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "approval", approvalId: "ap1", approvalKind: "exec", decision: "allow-once" },
    });
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "ap1",
        approvalKind: "exec",
        decision: "allow-once",
        channel: "max",
        senderId: "42",
      }),
    );
    expect(params.answerCallback).toHaveBeenCalledWith({
      message: { text: "Запустить деплой?\n\n✅ Decision recorded: allow-once." },
    });
  });

  it("answers with a toast when there is no source message text", async () => {
    const params = { ...baseParams(), sourceText: undefined };
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "approval", approvalId: "ap1", approvalKind: "plugin", decision: "deny" },
    });
    expect(params.answerCallback).toHaveBeenCalledWith({
      notification: "✅ Decision recorded: deny.",
    });
  });

  it("reports an already-resolved approval", async () => {
    resolveApproval.mockResolvedValueOnce({ applied: false });
    const params = baseParams();
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "approval", approvalId: "ap1", approvalKind: "exec", decision: "deny" },
    });
    expect(params.answerCallback).toHaveBeenCalledWith({
      message: { text: "Запустить деплой?\n\nℹ️ This approval was already resolved." },
    });
  });

  it("never calls the runtimes for an unauthorized sender", async () => {
    const params = { ...baseParams(), allowFrom: ["7"], senderId: "42" };
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "approval", approvalId: "ap1", approvalKind: "exec", decision: "allow-once" },
    });
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(params.answerCallback).toHaveBeenCalledWith({
      message: { text: "Запустить деплой?\n\n⛔ You are not allowed to answer this." },
    });
  });

  it("resolves a question option through the question runtime", async () => {
    const params = baseParams();
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "question", questionId: "q1", optionValue: "yes" },
    });
    expect(resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: "q1", optionValue: "yes", senderId: "42" }),
    );
    expect(params.answerCallback).toHaveBeenCalledWith({
      message: { text: "Запустить деплой?\n\n✅ Answer recorded." },
    });
  });

  it("reports a question that is no longer open", async () => {
    resolveQuestion.mockResolvedValueOnce({ status: "already-terminal", reason: "not-found" });
    const params = baseParams();
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "question", questionId: "q1", optionValue: "yes" },
    });
    expect(params.answerCallback).toHaveBeenCalledWith({
      message: { text: "Запустить деплой?\n\nℹ️ This question is no longer open." },
    });
  });

  it("survives a runtime failure with a warning status", async () => {
    resolveApproval.mockRejectedValueOnce(new Error("gateway down"));
    const params = baseParams();
    await resolveMaxRuntimeControlCallback({
      ...params,
      action: { kind: "approval", approvalId: "ap1", approvalKind: "exec", decision: "allow-once" },
    });
    expect(params.answerCallback).toHaveBeenCalledWith({
      message: { text: "Запустить деплой?\n\n⚠️ Could not apply this action." },
    });
  });
});
