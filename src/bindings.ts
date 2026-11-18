/**
 * Binding store for tracking the mapping between pi conversation branches and Antigravity Cascades.
 * Persists each session in its own isolated JSON file (<baseDir>/<sessionId>.json) to prevent
 * cross-session clobbering when running multiple sessions or concurrent pi instances.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface SessionBinding {
  cascadeId: string;
  lastLeafId: string;
  /** Map from pi entry id to the 0-based index of the final trajectory step completed at that turn */
  steps: Record<string, number>;
  /**
   * Transcript of the conversation that happened before this Cascade was created
   * (for example turns held with another provider). The Cascade's own trajectory
   * covers everything after creation, so only this prefix is replayed into the
   * prompt on later turns.
   */
  priorHistory?: string;
}

export class BindingStore {
  private baseDir: string;
  private readonly inMemory: boolean;
  private readonly memoryStore = new Map<string, string>();

  static inMemory(): BindingStore {
    return new BindingStore(":memory:");
  }

  constructor(customPath?: string) {
    if (customPath === ":memory:") {
      this.inMemory = true;
      this.baseDir = ":memory:";
    } else {
      this.inMemory = false;
      if (!customPath) {
        this.baseDir = path.join(os.homedir(), ".pi", "agent", "pi-antigravity-ls", "sessions");
      } else if (customPath.endsWith(".json")) {
        this.baseDir = path.dirname(customPath);
      } else {
        this.baseDir = customPath;
      }
    }
  }

  getSessionFilePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
    if (this.inMemory) {
      return `:memory:/${safeId}.json`;
    }
    return path.join(this.baseDir, `${safeId}.json`);
  }

  get(sessionId: string): SessionBinding | undefined {
    if (this.inMemory) {
      const raw = this.memoryStore.get(sessionId);
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.cascadeId === "string" &&
          typeof parsed.steps === "object" &&
          parsed.steps !== null
        ) {
          return parsed as SessionBinding;
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    const filePath = this.getSessionFilePath(sessionId);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.cascadeId === "string" &&
          typeof parsed.steps === "object" &&
          parsed.steps !== null
        ) {
          return parsed as SessionBinding;
        }
      }
    } catch {
      // Corrupt file for this session; fail-safe to undefined without affecting other sessions
    }
    return undefined;
  }

  set(sessionId: string, binding: SessionBinding): void {
    const serialized = JSON.stringify(binding, null, 2);

    if (this.inMemory) {
      this.memoryStore.set(sessionId, serialized);
      return;
    }

    const filePath = this.getSessionFilePath(sessionId);
    let tmpPath: string | null = null;
    try {
      if (fs.existsSync(filePath)) {
        try {
          const existing = fs.readFileSync(filePath, "utf8");
          if (existing === serialized) {
            return;
          }
        } catch {
          // If read fails, proceed to overwrite
        }
      }

      fs.mkdirSync(this.baseDir, { recursive: true });
      tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, serialized, "utf8");
      fs.renameSync(tmpPath, filePath);
      tmpPath = null;
    } catch (e: any) {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
      console.error(`[BindingStore] Failed to save binding to ${filePath}:`, e.message);
    }
  }

  remove(sessionId: string): void {
    if (this.inMemory) {
      this.memoryStore.delete(sessionId);
      return;
    }

    const filePath = this.getSessionFilePath(sessionId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e: any) {
      console.error(`[BindingStore] Failed to remove binding at ${filePath}:`, e.message);
    }
  }

  clear(): void {
    if (this.inMemory) {
      this.memoryStore.clear();
      return;
    }

    try {
      if (!fs.existsSync(this.baseDir)) return;
      for (const entry of fs.readdirSync(this.baseDir)) {
        if (entry.endsWith(".json")) {
          try {
            fs.unlinkSync(path.join(this.baseDir, entry));
          } catch {
            // ignore
          }
        }
      }
    } catch (e: any) {
      console.error(`[BindingStore] Failed to clear bindings in ${this.baseDir}:`, e.message);
    }
  }
}
