import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BindingStore } from "../../src/bindings.js";

describe("BindingStore (Per-Session Isolation & Persistence)", () => {
  const tmpDir = path.join(os.tmpdir(), `test_bindings_${Date.now()}`);

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
});
