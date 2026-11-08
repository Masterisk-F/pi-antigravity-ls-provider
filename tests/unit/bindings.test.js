import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BindingStore } from "../../src/bindings.js";
describe("BindingStore", () => {
    const tmpDir = path.join(os.tmpdir(), `test_bindings_${Date.now()}`);
    const tmpFile = path.join(tmpDir, "bindings.json");
    test("handles basic save, get, and persistence", () => {
        const store = new BindingStore(tmpFile);
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
        // Reload from disk
        const store2 = new BindingStore(tmpFile);
        assert.equal(store2.get("sess-1")?.cascadeId, "casc-100");
    });
    test("gracefully recovers from corrupt JSON", () => {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(tmpFile, "INVALID_CORRUPT_JSON{{{", "utf8");
        const store = new BindingStore(tmpFile);
        assert.equal(store.get("any"), undefined);
        // Can still write after corruption recovery
        store.set("sess-2", {
            cascadeId: "casc-200",
            lastLeafId: "leaf-b",
            steps: {},
        });
        assert.equal(store.get("sess-2")?.cascadeId, "casc-200");
    });
});
