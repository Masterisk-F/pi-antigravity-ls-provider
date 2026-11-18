import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { extractSystemPrompt, NORMALIZED_PREAMBLE } from "../../src/provider-stream.js";

async function loadPackageDefaultPreamble(): Promise<string> {
  const modPath = path.join(getPackageDir(), "dist", "core", "system-prompt.js");
  const mod = await import(pathToFileURL(modPath).href);
  return mod.buildSystemPromptSections({ cwd: "." }).preamble;
}

describe("extractSystemPrompt (sections.preamble replacement)", () => {
  test("replaces sections.preamble regardless of its original wording and preserves remaining sections", async () => {
    const messages = [
      {
        role: "system",
        content: "",
        sections: {
          preamble: "Any pi-generated preamble text here.",
          tools: "<tools>\n- read: Read file\n</tools>",
          rules: "<rules>\n- Be concise\n</rules>",
        },
        timestamp: 1,
      },
    ];

    const result = await extractSystemPrompt(messages);

    assert.equal(
      result,
      `${NORMALIZED_PREAMBLE}\n\n<tools>\n- read: Read file\n</tools>\n\n<rules>\n- Be concise\n</rules>`
    );
  });

  test("preserves non-preamble sections and applies mid-conversation section patches without altering other text", async () => {
    const messages = [
      {
        role: "system",
        content: "",
        sections: {
          preamble: "Initial preamble from pi.",
          project_context:
            "<project_context>\nReference text mentioning pi, a coding agent harness.\n</project_context>",
          rules: "<rules>\n- Old rule\n</rules>",
        },
        timestamp: 1,
      },
      { role: "user", content: "hi", timestamp: 2 },
      {
        role: "system",
        content: "",
        sections: {
          rules: "<rules>\n- Updated rule\n</rules>",
        },
        timestamp: 3,
      },
    ];

    const result = await extractSystemPrompt(messages);

    assert.equal(
      result,
      `${NORMALIZED_PREAMBLE}\n\n<project_context>\nReference text mentioning pi, a coding agent harness.\n</project_context>\n\n<rules>\n- Updated rule\n</rules>`
    );
  });

  test("does not mutate the original system message object", async () => {
    const originalPreamble = "Original preamble text.";
    const originalSections = {
      preamble: originalPreamble,
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

    await extractSystemPrompt(messages);

    assert.equal(originalSections.preamble, originalPreamble);
  });

  test("does not inject preamble when sections has no preamble key", async () => {
    const messages = [
      {
        role: "system",
        content: "Base instruction",
        sections: {
          cwd: "<cwd>\n/tmp\n</cwd>",
        },
        timestamp: 1,
      },
    ];

    const result = await extractSystemPrompt(messages);

    assert.equal(result, "Base instruction\n\n<cwd>\n/tmp\n</cwd>");
  });

  test("replaces pi package default preamble inside flat content-only system prompt (forceSystemPrompt)", async () => {
    const packageDefaultPreamble = await loadPackageDefaultPreamble();
    const prefix = "## Skill invocation protocol (CRITICAL)\n\nFollow skill blocks.\n\n";
    const suffix = "\n\n<tools>\n- read: Read file\n</tools>";
    const messages = [
      {
        role: "system",
        content: `${prefix}${packageDefaultPreamble}${suffix}`,
        timestamp: 1,
      },
    ];

    const result = await extractSystemPrompt(messages);

    assert.equal(result, `${prefix}${NORMALIZED_PREAMBLE}${suffix}`);
  });

  test("keeps plain content-only system messages intact when no default preamble is present", async () => {
    const plainPrompt = "Forced or plain system prompt.";
    const messages = [
      {
        role: "system",
        content: plainPrompt,
        timestamp: 1,
      },
    ];

    const result = await extractSystemPrompt(messages);

    assert.equal(result, plainPrompt);
  });

  test("falls back to default prompt when no system messages exist", async () => {
    const result = await extractSystemPrompt([{ role: "user", content: "hello", timestamp: 1 }]);
    assert.equal(result, "You are an expert AI software engineer operating as a coding agent.");
  });
});
