import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCascadeConfig } from "../../src/cascade-config.js";

describe("CascadeConfig Builder (Declarative Mixin)", () => {
  test("configures declarativeMixinConfig with only pi-tools in tool schema", () => {
    const config = buildCascadeConfig({
      modelId: 1419,
      systemPrompt: "Custom Pi Instructions",
    });

    const planner = config.plannerConfig;
    assert.equal(planner.noToolExplanation, true);
    assert.equal(planner.noToolSummary, true);
    assert.equal(planner.requestedModel.choice.value, 1419);

    const mixin = planner.plannerTypeConfig;
    assert.equal(mixin.case, "declarativeMixinConfig");

    // Tools whitelist contains only pi-tools
    const tools = mixin.value.tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].source.value, "pi-tools");
    assert.equal(tools[0].match.value, ".*");

    // Prompt section contains only pi_system, with pi's prompt passed through unchanged
    const sections = mixin.value.promptSections;
    assert.equal(sections.length, 1);
    assert.equal(sections[0].item.value.title, "pi_system");
    assert.equal(sections[0].item.value.content, "Custom Pi Instructions");
  });

  test("does not prepend any extra tool directive to pi's system prompt", () => {
    const config = buildCascadeConfig({
      modelId: 1419,
      systemPrompt: "pi system prompt",
    });

    const content =
      config.plannerConfig.plannerTypeConfig.value.promptSections[0].item.value.content;

    assert.equal(content.includes("CRITICAL TOOL USE DIRECTIVE"), false);
    assert.equal(content.includes("Antigravity built-in tools"), false);
    assert.equal(content.startsWith("#"), false);
  });

  test("falls back to a default prompt when systemPrompt is empty", () => {
    const config = buildCascadeConfig({
      modelId: 1419,
      systemPrompt: "",
    });

    const content =
      config.plannerConfig.plannerTypeConfig.value.promptSections[0].item.value.content;

    assert.ok(content.length > 0);
    assert.equal(content.includes("CRITICAL TOOL USE DIRECTIVE"), false);
  });

  test("uses the instance-unique MCP server name as the tool provider", () => {
    const config = buildCascadeConfig({
      modelId: 1419,
      systemPrompt: "prompt",
      mcpServerName: "pi-tools-4321",
    });

    const tools = config.plannerConfig.plannerTypeConfig.value.tools;
    assert.equal(tools[0].source.value, "pi-tools-4321");
  });

  test("injects conversation_history as a second prompt section when provided", () => {
    const config = buildCascadeConfig({
      modelId: 1419,
      systemPrompt: "pi system prompt",
      conversationHistory: "[User]: codename is ZETA-9\n\n[Assistant]: Noted.",
    });

    const sections = config.plannerConfig.plannerTypeConfig.value.promptSections;
    assert.equal(sections.length, 2);
    assert.equal(sections[0].item.value.title, "pi_system");
    assert.equal(sections[0].item.value.content, "pi system prompt");
    assert.equal(sections[1].item.value.title, "conversation_history");
    assert.ok(sections[1].item.value.content.includes("ZETA-9"));
    assert.ok(sections[1].item.value.content.includes("conversation history"));
  });

  test("omits the conversation_history section when history is absent or blank", () => {
    for (const conversationHistory of [undefined, "", "   \n\t "]) {
      const config = buildCascadeConfig({
        modelId: 1419,
        systemPrompt: "prompt",
        conversationHistory,
      });

      const sections = config.plannerConfig.plannerTypeConfig.value.promptSections;
      assert.equal(sections.length, 1);
      assert.equal(sections[0].item.value.title, "pi_system");
    }
  });
});
