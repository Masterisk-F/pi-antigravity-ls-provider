import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RoundTrip, type ParkEvent } from "../../src/tool-bridge/round-trip.js";

describe("RoundTrip Store", () => {
  test("parks tool call, emits event, and resolves", async () => {
    const rt = new RoundTrip();
    let emittedEvent: ParkEvent | null = null;

    rt.on("park", (ev) => {
      emittedEvent = ev;
    });

    const promise = rt.park("call-1", "pi_write", { path: "test.txt", content: "hello" });

    assert.equal(rt.hasParkedCalls(), true);
    assert.equal(rt.getParkedCount(), 1);
    assert.ok(emittedEvent);
    assert.equal((emittedEvent as ParkEvent).callId, "call-1");
    assert.equal((emittedEvent as ParkEvent).toolName, "pi_write");

    const resolved = rt.resolve("call-1", { status: "success" });
    assert.equal(resolved, true);

    const result = await promise;
    assert.deepEqual(result, { status: "success" });
    assert.equal(rt.hasParkedCalls(), false);
  });

  test("handles multiple concurrent park calls (Section 3.1a)", async () => {
    const rt = new RoundTrip();
    const calls: ParkEvent[] = [];

    rt.on("park", (ev) => calls.push(ev));

    const p1 = rt.park("call-a", "pi_read", { path: "a.txt" });
    const p2 = rt.park("call-b", "pi_edit", { path: "b.txt" });

    assert.equal(rt.getParkedCount(), 2);
    assert.equal(calls.length, 2);

    // Resolve in reverse order
    rt.resolve("call-b", "res-b");
    assert.equal(await p2, "res-b");
    assert.equal(rt.getParkedCount(), 1);

    rt.resolve("call-a", "res-a");
    assert.equal(await p1, "res-a");
    assert.equal(rt.getParkedCount(), 0);
  });

  test("aborts all pending calls on abortAll", async () => {
    const rt = new RoundTrip();
    const p1 = rt.park("call-x", "pi_bash", { command: "sleep 10" });

    rt.abortAll("User cancelled");

    await assert.rejects(p1, /User cancelled/);
    assert.equal(rt.hasParkedCalls(), false);
  });
});
