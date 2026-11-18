import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";

describe("RoundTrip Result Staging (D-01)", () => {
  test("stageResult stages result without immediately resolving the parked promise", async () => {
    const rt = new RoundTrip();
    let isSettled = false;

    const promise = rt.park("call-1", "read", { path: "a.txt" });
    promise.then(() => {
      isSettled = true;
    });

    assert.equal(rt.hasParkedCalls(), true);
    assert.equal(rt.hasStagedResults(), false);

    // Stage the result (e.g. from pi.on("tool_result"))
    const staged = rt.stageResult("call-1", { content: [{ type: "text", text: "hello" }] });
    assert.equal(staged, true);
    assert.equal(rt.hasStagedResults(), true);
    assert.equal(rt.getStagedCount(), 1);

    // Allow any microtasks to tick
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(isSettled, false, "Promise must remain pending until flushStagedResults is called");

    // Flush staged results (e.g. on continuation stream listener attachment)
    const flushedCount = rt.flushStagedResults();
    assert.equal(flushedCount, 1);
    assert.equal(rt.hasStagedResults(), false);

    const result = await promise;
    assert.deepEqual(result, { content: [{ type: "text", text: "hello" }] });
    assert.equal(isSettled, true);
    assert.equal(rt.hasParkedCalls(), false);
  });

  test("stageResult returns false for unknown or non-parked callId without side effects", () => {
    const rt = new RoundTrip();
    const staged = rt.stageResult("non-existent-call", { output: "foo" });
    assert.equal(staged, false);
    assert.equal(rt.hasStagedResults(), false);
    assert.equal(rt.flushStagedResults(), 0);
  });

  test("direct resolve clears staged result for that callId", async () => {
    const rt = new RoundTrip();
    const promise = rt.park("call-2", "bash", { command: "ls" });

    rt.stageResult("call-2", { text: "staged-output" });
    assert.equal(rt.getStagedCount(), 1);

    // Direct resolve (e.g. fallback resolution in provider-stream)
    const resolved = rt.resolve("call-2", { text: "direct-output" });
    assert.equal(resolved, true);
    assert.equal(rt.hasStagedResults(), false);

    const result = await promise;
    assert.deepEqual(result, { text: "direct-output" });
  });

  test("direct reject clears staged result for that callId", async () => {
    const rt = new RoundTrip();
    const promise = rt.park("call-3", "bash", { command: "exit 1" });

    rt.stageResult("call-3", { text: "staged-output" });
    assert.equal(rt.getStagedCount(), 1);

    rt.reject("call-3", new Error("Tool failure"));
    assert.equal(rt.hasStagedResults(), false);

    await assert.rejects(promise, /Tool failure/);
  });

  test("abortAll clears both parkedCalls and stagedResults", async () => {
    const rt = new RoundTrip();
    const p1 = rt.park("call-a", "read", { path: "a.txt" });
    const p2 = rt.park("call-b", "read", { path: "b.txt" });

    rt.stageResult("call-a", "res-a");
    assert.equal(rt.getParkedCount(), 2);
    assert.equal(rt.getStagedCount(), 1);

    rt.abortAll("Session shutdown");

    assert.equal(rt.hasParkedCalls(), false);
    assert.equal(rt.hasStagedResults(), false);
    await assert.rejects(p1, /Session shutdown/);
    await assert.rejects(p2, /Session shutdown/);
  });
});
