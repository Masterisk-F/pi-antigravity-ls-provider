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

    // Prompt section contains only pi_system
    const sections = mixin.value.promptSections;
    assert.equal(sections.length, 1);
    assert.equal(sections[0].item.value.title, "pi_system");
    assert.equal(sections[0].item.value.content, "Custom Pi Instructions");
  });
});
