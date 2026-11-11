import { describe, it } from "node:test";
import * as assert from "node:assert";
import { extractTurnUserPrompts } from "../../src/provider-stream.js";

describe("extractTurnUserPrompts (Unit)", () => {
  it("extracts single user prompt in initial turn", () => {
    const messages = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Hello, check this code." },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, ["Hello, check this code."]);
  });

  it("extracts multiple sequential user prompts (user prompt + plannotator framing)", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "PI_TOOLS_DIRECTIVE って、削除したい。\nまたnonExecutableInPiも不要と考える。",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[PLANNOTATOR - PLANNING PHASE]\nYou are in plan mode.",
          },
        ],
      },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, [
      "PI_TOOLS_DIRECTIVE って、削除したい。\nまたnonExecutableInPiも不要と考える。",
      "[PLANNOTATOR - PLANNING PHASE]\nYou are in plan mode.",
    ]);
  });

  it("returns empty array when turn contains toolResult (tool continuation)", () => {
    const messages = [
      { role: "user", content: "List directory files" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123",
        toolName: "bash",
        content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
      },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, []);
  });

  it("extracts user prompts after a terminating tool call (e.g. plannotator_submit_plan followed by plan approval)", () => {
    const messages = [
      { role: "user", content: "Create a plan" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_submit",
            name: "plannotator_submit_plan",
            arguments: { filePath: "PLAN.md" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_submit",
        toolName: "plannotator_submit_plan",
        content: [{ type: "text", text: "Plan PLAN.md submitted for review in Plannotator." }],
      },
      {
        role: "user",
        content: "Plan approved. You now have full tool access. Execute the plan in PLAN.md.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[PLANNOTATOR - EXECUTING PLAN]\nThe planning phase is over.",
          },
        ],
      },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, [
      "Plan approved. You now have full tool access. Execute the plan in PLAN.md.",
      "[PLANNOTATOR - EXECUTING PLAN]\nThe planning phase is over.",
    ]);
  });

  it("extracts user prompt after tool execution was aborted mid-run", () => {
    const messages = [
      { role: "user", content: "Run long running command" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash_long",
            name: "bash",
            arguments: { command: "sleep 100" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash_long",
        toolName: "bash",
        content: [{ type: "text", text: "Command aborted" }],
        isError: true,
      },
      {
        role: "user",
        content: "Let us try a faster command instead.",
      },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, ["Let us try a faster command instead."]);
  });

  it("returns empty array for parallel tool call continuations without user messages", () => {
    const messages = [
      { role: "user", content: "Read two files" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_read_1",
            name: "read",
            arguments: { path: "a.txt" },
          },
          {
            type: "toolCall",
            id: "call_read_2",
            name: "read",
            arguments: { path: "b.txt" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_read_1",
        toolName: "read",
        content: [{ type: "text", text: "content A" }],
      },
      {
        role: "toolResult",
        toolCallId: "call_read_2",
        toolName: "read",
        content: [{ type: "text", text: "content B" }],
      },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, []);
  });

  it("extracts only messages after the most recent assistant response in multi-turn conversation", () => {
    const messages = [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: [{ type: "text", text: "Previous answer" }] },
      { role: "user", content: "New question 1" },
      { role: "user", content: "New question 2 (framing)" },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, ["New question 1", "New question 2 (framing)"]);
  });

  it("filters out empty strings and whitespace-only contents", () => {
    const messages = [
      { role: "user", content: "   " },
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "Valid text" }] },
      { role: "user", content: [] },
    ];

    const result = extractTurnUserPrompts(messages);
    assert.deepStrictEqual(result, ["Valid text"]);
  });
});
