import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "../../src/models.js";

describe("ModelCatalog Resolution & Model Isolation", () => {
  const catalog = new ModelCatalog();

  describe("Gemini 3.8 Flash (Numeric IDs: 1318, 1319, 1320)", () => {
    test("resolves effort: low / minimal to 1320 and gemini-3.8-flash-low", () => {
      const resLow = catalog.resolveModel("gemini-3.8-flash", "low");
      assert.equal(resLow.numericId, 1320);
      assert.equal(resLow.modelName, "gemini-3.8-flash-low");

      const resMinimal = catalog.resolveModel("gemini-3.8-flash", "minimal");
      assert.equal(resMinimal.numericId, 1320);
      assert.equal(resMinimal.modelName, "gemini-3.8-flash-low");
    });

    test("resolves effort: medium / unspecified to 1319 and gemini-3.8-flash-medium", () => {
      const resMed = catalog.resolveModel("gemini-3.8-flash", "medium");
      assert.equal(resMed.numericId, 1319);
      assert.equal(resMed.modelName, "gemini-3.8-flash-medium");

      const resDefault = catalog.resolveModel("gemini-3.8-flash");
      assert.equal(resDefault.numericId, 1319);
      assert.equal(resDefault.modelName, "gemini-3.8-flash-medium");
    });

    test("resolves effort: high / xhigh / max to 1318 and gemini-3.8-flash-high", () => {
      const resHigh = catalog.resolveModel("gemini-3.8-flash", "high");
      assert.equal(resHigh.numericId, 1318);
      assert.equal(resHigh.modelName, "gemini-3.8-flash-high");

      const resXhigh = catalog.resolveModel("gemini-3.8-flash", "xhigh");
      assert.equal(resXhigh.numericId, 1318);
      assert.equal(resXhigh.modelName, "gemini-3.8-flash-high");

      const resMax = catalog.resolveModel("gemini-3.8-flash", "max");
      assert.equal(resMax.numericId, 1318);
      assert.equal(resMax.modelName, "gemini-3.8-flash-high");
    });

    test("resolves with provider prefix antigravity-ls/gemini-3.8-flash", () => {
      const res = catalog.resolveModel("antigravity-ls/gemini-3.8-flash", "medium");
      assert.equal(res.numericId, 1319);
      assert.equal(res.modelName, "gemini-3.8-flash-medium");
    });

    test("resolves legacy underscore alias gemini_3_8_flash", () => {
      const res = catalog.resolveModel("gemini_3_8_flash", "high");
      assert.equal(res.numericId, 1318);
      assert.equal(res.modelName, "gemini-3.8-flash-high");
    });
  });

  describe("Gemini 4 Argon (Numeric IDs: 1417, 1418, 1419)", () => {
    test("resolves effort: low to 1419 and gemini-4-argon-low", () => {
      const res = catalog.resolveModel("gemini-4-argon", "low");
      assert.equal(res.numericId, 1419);
      assert.equal(res.modelName, "gemini-4-argon-low");
    });

    test("resolves effort: medium to 1418 and gemini-4-argon-medium", () => {
      const res = catalog.resolveModel("gemini-4-argon", "medium");
      assert.equal(res.numericId, 1418);
      assert.equal(res.modelName, "gemini-4-argon-medium");
    });

    test("resolves effort: high to 1417 and gemini-4-argon-high", () => {
      const res = catalog.resolveModel("gemini-4-argon", "high");
      assert.equal(res.numericId, 1417);
      assert.equal(res.modelName, "gemini-4-argon-high");
    });

    test("resolves with provider prefix antigravity-ls/gemini-4-argon", () => {
      const res = catalog.resolveModel("antigravity-ls/gemini-4-argon", "medium");
      assert.equal(res.numericId, 1418);
      assert.equal(res.modelName, "gemini-4-argon-medium");
    });
  });

  describe("Strict Model Separation (Gemini 3.8 Flash vs Gemini 4 Argon)", () => {
    test("flash and argon must never share the same numericId or modelName prefix", () => {
      for (const effort of ["low", "medium", "high"]) {
        const flash = catalog.resolveModel("gemini-3.8-flash", effort);
        const argon = catalog.resolveModel("gemini-4-argon", effort);

        assert.notEqual(flash.numericId, argon.numericId, `numericId must differ for effort ${effort}`);
        assert.ok(flash.modelName?.startsWith("gemini-3.8-flash-"));
        assert.ok(argon.modelName?.startsWith("gemini-4-argon-"));
      }
    });
  });

  describe("Claude & GPT-OSS Models Regression", () => {
    test("resolves claude-sonnet-5-5 correctly across tiers", () => {
      assert.deepEqual(catalog.resolveModel("claude-sonnet-5-5", "low"), {
        numericId: 1403,
        modelName: "claude-sonnet-5-5-low",
      });
      assert.deepEqual(catalog.resolveModel("claude-sonnet-5-5", "medium"), {
        numericId: 1404,
        modelName: "claude-sonnet-5-5-medium",
      });
      assert.deepEqual(catalog.resolveModel("claude-sonnet-5-5", "high"), {
        numericId: 1405,
        modelName: "claude-sonnet-5-5-high",
      });
    });

    test("resolves claude-opus-5-5 correctly across tiers", () => {
      assert.deepEqual(catalog.resolveModel("claude-opus-5-5", "low"), {
        numericId: 1400,
        modelName: "claude-opus-5-5-low",
      });
      assert.deepEqual(catalog.resolveModel("claude-opus-5-5", "medium"), {
        numericId: 1401,
        modelName: "claude-opus-5-5-medium",
      });
      assert.deepEqual(catalog.resolveModel("claude-opus-5-5", "high"), {
        numericId: 1402,
        modelName: "claude-opus-5-5-high",
      });
    });

    test("resolves gpt-oss-120b correctly", () => {
      assert.deepEqual(catalog.resolveModel("gpt-oss-120b"), {
        numericId: 342,
        modelName: "gpt-oss-120b-medium",
      });
    });
  });

  describe("Fallback Behavior", () => {
    test("falls back to Gemini 3.8 Flash Medium for unknown model ID", () => {
      const res = catalog.resolveModel("unknown-model-xyz");
      assert.equal(res.numericId, 1319);
      assert.equal(res.modelName, "gemini-3.8-flash-medium");
    });
  });
});
