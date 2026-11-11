import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  formatConversationHistory,
  resolvePriorHistory,
  resolveLeafKey,
} from "../../src/provider-stream.js";

describe("formatConversationHistory (Unit)", () => {
  it("serializes alternating user and assistant text turns", () => {
    const messages = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "What is the project codename?" },
      { role: "assistant", content: [{ type: "text", text: "It is ZETA-9." }] },
    ];

    const result = formatConversationHistory(messages);

    assert.strictEqual(result, "[User]: What is the project codename?\n\n[Assistant]: It is ZETA-9.");
  });

  it("serializes assistant tool calls and tool results", () => {
    const messages = [
      { role: "user", content: "Read config.yaml" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it now." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.yaml" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "redis:\n  port: 6389" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "Port is 6389." }] },
    ];

    const result = formatConversationHistory(messages);

    assert.ok(result.includes("[User]: Read config.yaml"));
    assert.ok(result.includes("[Assistant]: Reading it now."));
    assert.ok(result.includes('[Assistant tool calls]: read(path="config.yaml")'));
    assert.ok(result.includes("[Tool result (read)]: redis:"));
    assert.ok(result.includes("[Assistant]: Port is 6389."));
  });

  it("omits thinking blocks while keeping text and tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_REASONING_SHOULD_NOT_APPEAR" },
          { type: "text", text: "Visible answer." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ];

    const result = formatConversationHistory(messages);

    assert.strictEqual(result.includes("SECRET_REASONING_SHOULD_NOT_APPEAR"), false);
    assert.ok(result.includes("[Assistant]: Visible answer."));
    assert.ok(result.includes('[Assistant tool calls]: bash(command="ls")'));
  });

  it("excludes system messages from the transcript", () => {
    const messages = [
      { role: "system", content: "SYSTEM_PROMPT_SHOULD_NOT_APPEAR" },
      { role: "user", content: "hello" },
    ];

    const result = formatConversationHistory(messages);

    assert.strictEqual(result.includes("SYSTEM_PROMPT_SHOULD_NOT_APPEAR"), false);
    assert.strictEqual(result, "[User]: hello");
  });

  it("truncates oversized tool results", () => {
    const huge = "x".repeat(5000);
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: huge }],
        isError: false,
      },
    ];

    const result = formatConversationHistory(messages);

    assert.ok(result.includes("[truncated]"));
    assert.ok(result.length < huge.length);
  });

  it("returns an empty string when there is nothing to serialize", () => {
    assert.strictEqual(formatConversationHistory([]), "");
    assert.strictEqual(formatConversationHistory([{ role: "system", content: "only system" }]), "");
    assert.strictEqual(formatConversationHistory([{ role: "user", content: "   " }]), "");
  });
});

describe("resolvePriorHistory (Unit)", () => {
  it("reports no history when no assistant turn exists yet", () => {
    const result = resolvePriorHistory([
      { role: "system", content: "prompt" },
      { role: "user", content: "first ever prompt" },
    ]);

    assert.strictEqual(result.priorHistory, "");
    assert.strictEqual(result.isExternalSwitch, false);
  });

  it("flags a switch when the last assistant turn came from another provider", () => {
    const result = resolvePriorHistory([
      { role: "system", content: "prompt" },
      { role: "user", content: "codename is ZETA-9" },
      {
        role: "assistant",
        provider: "anthropic",
        content: [{ type: "text", text: "Noted." }],
      },
      { role: "user", content: "what is the codename?" },
    ]);

    assert.strictEqual(result.isExternalSwitch, true);
    assert.ok(result.priorHistory.includes("[User]: codename is ZETA-9"));
    assert.ok(result.priorHistory.includes("[Assistant]: Noted."));
    // The current turn's prompt must not be part of the history prefix.
    assert.strictEqual(result.priorHistory.includes("what is the codename?"), false);
  });

  it("does not flag a switch when the last assistant turn came from this provider", () => {
    const result = resolvePriorHistory([
      { role: "system", content: "prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", provider: "antigravity-ls", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "next" },
    ]);

    assert.strictEqual(result.isExternalSwitch, false);
    assert.ok(result.priorHistory.includes("[Assistant]: hi"));
  });

  it("does not flag a switch when the provider is absent from a legacy message", () => {
    const result = resolvePriorHistory([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "next" },
    ]);

    assert.strictEqual(result.isExternalSwitch, false);
  });
});

describe("resolveLeafKey (Unit)", () => {
  it("prefers the session entry id", () => {
    assert.strictEqual(resolveLeafKey({ id: "entry-42", role: "user" }, 3), "entry-42");
  });

  it("falls back to a stable positional key when no id exists", () => {
    assert.strictEqual(resolveLeafKey({ role: "assistant", timestamp: 1700 }, 7), "assistant:1700:7");
    assert.strictEqual(resolveLeafKey({}, 2), "unknown:0:2");
    assert.strictEqual(resolveLeafKey(undefined, 5), "leaf:5");
  });
});
