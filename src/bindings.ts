/**
 * Binding store for tracking the mapping between pi conversation branches and Antigravity Cascades.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface SessionBinding {
  cascadeId: string;
  lastLeafId: string;
  /** Map from pi entry id to the trajectory step count at that point */
  steps: Record<string, number>;
  /**
   * Transcript of the conversation that happened before this Cascade was created
   * (for example turns held with another provider). The Cascade's own trajectory
   * covers everything after creation, so only this prefix is replayed into the
   * prompt on later turns.
   */
  priorHistory?: string;
}

export interface BindingsFileSchema {
  sessions: Record<string, SessionBinding>;
}

export class BindingStore {
  private filePath: string;
  private data: BindingsFileSchema = { sessions: {} };

  constructor(customPath?: string) {
    this.filePath =
      customPath ||
      path.join(os.homedir(), ".pi", "agent", "pi-antigravity-ls", "bindings.json");
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.sessions === "object") {
          this.data = parsed;
          return;
        }
      }
    } catch {
      // Corrupt file, fail-safe to empty
    }
    this.data = { sessions: {} };
  }

  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
    } catch (e: any) {
      console.error(`[BindingStore] Failed to save bindings to ${this.filePath}:`, e.message);
    }
  }

  get(sessionId: string): SessionBinding | undefined {
    return this.data.sessions[sessionId];
  }

  set(sessionId: string, binding: SessionBinding): void {
    this.data.sessions[sessionId] = binding;
    this.save();
  }

  remove(sessionId: string): void {
    delete this.data.sessions[sessionId];
    this.save();
  }

  clear(): void {
    this.data = { sessions: {} };
    this.save();
  }
}
