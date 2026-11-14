import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { extractSystemPrompt, NORMALIZED_PREAMBLE } from "../../src/provider-stream.js";

const V140_PREAMBLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const V150_PREAMBLE =
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

describe("extractSystemPrompt (sections.preamble replacement)", () => {
  test("replaces pi v1.4.0 default sections.preamble and preserves remaining sections", () => {
    const messages = [
      {
        role: "system",
        content: "",
        sections: {
          preamble: V140_PREAMBLE,
          tools: "<tools>\n- read: Read file\n</tools>",
          rules: "<rules>\n- Be concise\n</rules>",
        },
        timestamp: 1,
      },
    ];

    const result = extractSystemPrompt(messages);

    assert.equal(
      result,
      `${NORMALIZED_PREAMBLE}\n\n<tools>\n- read: Read file\n</tools>\n\n<rules>\n- Be concise\n</rules>`
    );
  });

  test("replaces pi v1.5.0 default sections.preamble", () => {
    const messages = [
      {
        role: "system",
        content: "",
        sections: {
          preamble: V150_PREAMBLE,
          cwd: "<cwd>\n/tmp/work\n</cwd>",
        },
        timestamp: 1,
      },
    ];

    const result = extractSystemPrompt(messages);

    assert.equal(result, `${NORMALIZED_PREAMBLE}\n\n<cwd>\n/tmp/work\n</cwd>`);
  });

  test("preserves non-preamble sections containing identical pi harness wording even with mid-conversation patches", () => {
    const messages = [
      {
        role: "system",
        content: "",
        sections: {
          preamble: V150_PREAMBLE,
          project_context: `<project_context>\nReference text: ${V140_PREAMBLE}\n</project_context>`,
          rules: "<rules>\n- Keep pi, a coding agent harness note intact\n</rules>",
        },
        timestamp: 1,
      },
      { role: "user", content: "hi", timestamp: 2 },
      {
        role: "system",
        content: "",
        sections: {
          rules: "<rules>\n- Updated rule mentioning pi, a coding agent harness\n</rules>",
        },
        timestamp: 3,
      },
    ];

    const result = extractSystemPrompt(messages);

    assert.ok(result.startsWith(`${NORMALIZED_PREAMBLE}\n\n`));
    assert.ok(result.includes(`Reference text: ${V140_PREAMBLE}`));
    assert.ok(result.includes("Updated rule mentioning pi, a coding agent harness"));
  });

  test("does not mutate the original system message object", () => {
    const originalSections = {
      preamble: V140_PREAMBLE,
      tools: "<tools>\n(none)\n</tools>",
    };
    const messages = [
      {
        role: "system",
        content: "",
        sections: originalSections,
        timestamp: 1,
      },
    ];

    extractSystemPrompt(messages);

    assert.equal(originalSections.preamble, V140_PREAMBLE);
  });

  test("keeps custom sections.preamble intact", () => {
    const customPreamble = "You are a custom security auditor.";
    const messages = [
      {
        role: "system",
        content: "",
        sections: {
          preamble: customPreamble,
          cwd: "<cwd>\n/tmp\n</cwd>",
        },
        timestamp: 1,
      },
    ];

    const result = extractSystemPrompt(messages);

    assert.equal(result, `${customPreamble}\n\n<cwd>\n/tmp\n</cwd>`);
  });

  test("keeps plain content-only system messages intact without string replacement", () => {
    const messages = [
      {
        role: "system",
        content: V140_PREAMBLE,
        timestamp: 1,
      },
    ];

    const result = extractSystemPrompt(messages);

    assert.equal(result, V140_PREAMBLE);
  });

  test("falls back to default prompt when no system messages exist", () => {
    const result = extractSystemPrompt([{ role: "user", content: "hello", timestamp: 1 }]);
    assert.equal(result, "You are an expert AI software engineer operating as a coding agent.");
  });
});
