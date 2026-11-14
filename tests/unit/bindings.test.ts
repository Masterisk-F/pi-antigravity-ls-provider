import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BindingStore } from "../../src/bindings.js";

describe("BindingStore (Per-Session Isolation & Persistence)", () => {
  const tmpDir = path.join(os.tmpdir(), `test_bindings_${Date.now()}`);

  after(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  test("handles basic save, get, and per-session file persistence (D-03)", () => {
    const store = new BindingStore(tmpDir);
    assert.equal(store.get("sess-1"), undefined);

    store.set("sess-1", {
      cascadeId: "casc-100",
      lastLeafId: "leaf-a",
      steps: { "leaf-a": 3 },
    });

    const read = store.get("sess-1");
    assert.ok(read);
    assert.equal(read.cascadeId, "casc-100");
    assert.equal(read.lastLeafId, "leaf-a");
    assert.equal(read.steps["leaf-a"], 3);

    // Verify individual session file exists on disk
    const sessionFile = store.getSessionFilePath("sess-1");
    assert.ok(fs.existsSync(sessionFile), `Session file must exist: ${sessionFile}`);
    const onDisk = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    assert.equal(onDisk.cascadeId, "casc-100");

    // Fresh store instance reads it
    const store2 = new BindingStore(tmpDir);
    assert.equal(store2.get("sess-1")?.cascadeId, "casc-100");
  });

  test("isolates multiple sessions without overwriting each other (D-03)", () => {
    const storeA = new BindingStore(tmpDir);
    const storeB = new BindingStore(tmpDir);

    storeA.set("sess-alpha", {
      cascadeId: "casc-alpha",
      lastLeafId: "leaf-alpha",
      steps: { "leaf-alpha": 1 },
    });

    storeB.set("sess-beta", {
      cascadeId: "casc-beta",
      lastLeafId: "leaf-beta",
      steps: { "leaf-beta": 2 },
    });

    // Both sessions must exist independently
    assert.equal(storeA.get("sess-alpha")?.cascadeId, "casc-alpha");
    assert.equal(storeA.get("sess-beta")?.cascadeId, "casc-beta");
    assert.equal(storeB.get("sess-alpha")?.cascadeId, "casc-alpha");
    assert.equal(storeB.get("sess-beta")?.cascadeId, "casc-beta");

    // Removing sess-alpha does not affect sess-beta
    storeA.remove("sess-alpha");
    assert.equal(storeA.get("sess-alpha"), undefined);
    assert.equal(storeA.get("sess-beta")?.cascadeId, "casc-beta");
    assert.equal(storeB.get("sess-beta")?.cascadeId, "casc-beta");
  });

  test("gracefully recovers from corrupt JSON for one session without affecting others", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const corruptFile = path.join(tmpDir, "sess-corrupt.json");
    fs.writeFileSync(corruptFile, "INVALID_CORRUPT_JSON{{{", "utf8");

    const store = new BindingStore(tmpDir);
    store.set("sess-healthy", {
      cascadeId: "casc-healthy",
      lastLeafId: "leaf-h",
      steps: {},
    });

    // Corrupt session returns undefined
    assert.equal(store.get("sess-corrupt"), undefined);

    // Healthy session is unaffected
    assert.equal(store.get("sess-healthy")?.cascadeId, "casc-healthy");

    // Can overwrite corrupt file with valid data
    store.set("sess-corrupt", {
      cascadeId: "casc-recovered",
      lastLeafId: "leaf-r",
      steps: {},
    });
    assert.equal(store.get("sess-corrupt")?.cascadeId, "casc-recovered");
  });

  test("skips redundant write when binding content is identical (D-02)", async () => {
    const store = new BindingStore(tmpDir);
    const binding = {
      cascadeId: "casc-dedup",
      lastLeafId: "leaf-1",
      steps: { "leaf-1": 1 },
    };
    store.set("sess-dedup", binding);
    const sessionFile = store.getSessionFilePath("sess-dedup");
    assert.ok(fs.existsSync(sessionFile));
    const stat1 = fs.statSync(sessionFile);

    // Wait a short delay to ensure mtime resolution difference if re-written
    await new Promise((r) => setTimeout(r, 25));

    // Set identical content -> should skip write
    store.set("sess-dedup", binding);
    const stat2 = fs.statSync(sessionFile);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, "mtime must not change when content is identical");

    // Update content -> mtime should change
    await new Promise((r) => setTimeout(r, 25));
    store.set("sess-dedup", { ...binding, lastLeafId: "leaf-2" });
    const stat3 = fs.statSync(sessionFile);
    assert.notEqual(stat1.mtimeMs, stat3.mtimeMs, "mtime must update when content changes");
  });
});

describe("BindingStore (In-Memory Mode - D-01)", () => {
  test("operates completely in-memory with zero file I/O and proper isolation", () => {
    const store = BindingStore.inMemory();
    assert.equal(store.get("sess-mem-1"), undefined);

    const initialBinding = {
      cascadeId: "casc-mem",
      lastLeafId: "leaf-1",
      steps: { "leaf-1": 1 },
      priorHistory: "[User]: test",
    };

    store.set("sess-mem-1", initialBinding);

    const fetched = store.get("sess-mem-1");
    assert.ok(fetched);
    assert.equal(fetched.cascadeId, "casc-mem");
    assert.equal(fetched.lastLeafId, "leaf-1");
    assert.equal(fetched.steps["leaf-1"], 1);
    assert.equal(fetched.priorHistory, "[User]: test");

    // Deep-copy isolation test: mutating fetched object must not alter store without set()
    fetched.steps["leaf-mutated"] = 999;
    const refetched = store.get("sess-mem-1");
    assert.equal(refetched?.steps["leaf-mutated"], undefined, "Store must maintain value isolation");

    // Multi-session isolation
    store.set("sess-mem-2", {
      cascadeId: "casc-mem-2",
      lastLeafId: "leaf-2",
      steps: {},
    });
    assert.equal(store.get("sess-mem-2")?.cascadeId, "casc-mem-2");

    // remove
    store.remove("sess-mem-1");
    assert.equal(store.get("sess-mem-1"), undefined);
    assert.equal(store.get("sess-mem-2")?.cascadeId, "casc-mem-2");

    // clear
    store.clear();
    assert.equal(store.get("sess-mem-2"), undefined);

    // getSessionFilePath returns virtual path
    assert.equal(store.getSessionFilePath("sess-mem-1"), ":memory:/sess-mem-1.json");
  });
});
