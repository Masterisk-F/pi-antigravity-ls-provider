import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCascadeConfig, BUILTIN_PROMPT_SECTIONS } from "../../src/cascade-config.js";

describe("CascadeConfig Builder", () => {
  test("disables all builtin tools while keeping mcp enabled", () => {
    const config = buildCascadeConfig({
      modelId: 1419,
      systemPrompt: "Test System Prompt",
    });

    const planner = config.plannerConfig;
    assert.equal(planner.noToolExplanation, true);
    assert.equal(planner.noToolSummary, true);
    assert.equal(planner.requestedModel.choice.value, 1419);

    const tc = planner.toolConfig;
    assert.equal(tc.runCommand.forceDisable, true);
    assert.equal(tc.code.forceDisable, true);
    assert.equal(tc.mquery.forceDisable, true);
    assert.equal(tc.searchWeb.forceDisable, true);
    assert.equal(tc.memory.forceDisable, true);
    assert.equal(tc.generateImage.forceDisable, true);
    assert.equal(tc.suggestedResponse.forceDisable, true);
    assert.equal(tc.trajectorySearch.forceDisable, true);

    assert.equal(tc.invokeSubagent.enabled, false);
    assert.equal(tc.antigravityBrowser.enabled, false);
    assert.equal(tc.notebookEdit.enabled, false);
    assert.equal(tc.askQuestion.enabled, false);
    assert.equal(tc.readKnowledgeBaseItem.enabled, false);
    assert.equal(tc.disableSimpleResearchTools, true);

    // MCP tool config should NOT be force-disabled
    assert.equal((tc as any).mcp?.forceDisable ?? false, false);
  });

  test("removes all 11 default prompt sections and appends pi prompt", () => {
    const config = buildCascadeConfig({
      modelId: 1418,
      systemPrompt: "Custom Pi Instructions",
    });

    const psc = config.plannerConfig.promptSectionCustomizationConfig;
    assert.equal(psc.removePromptSections.length, 11);
    for (const sec of BUILTIN_PROMPT_SECTIONS) {
      assert.ok(psc.removePromptSections.includes(sec as any));
    }

    assert.equal(psc.appendPromptSections.length, 1);
    assert.equal(psc.appendPromptSections[0].title, "pi_system");
    assert.equal(psc.appendPromptSections[0].content, "Custom Pi Instructions");
  });
});
