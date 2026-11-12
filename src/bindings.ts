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

  constructor(customPath?: string) {
    if (!customPath) {
      this.baseDir = path.join(os.homedir(), ".pi", "agent", "pi-antigravity-ls", "sessions");
    } else if (customPath.endsWith(".json")) {
      this.baseDir = path.dirname(customPath);
    } else {
      this.baseDir = customPath;
    }
  }

  getSessionFilePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
    return path.join(this.baseDir, `${safeId}.json`);
  }

  get(sessionId: string): SessionBinding | undefined {
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
    const filePath = this.getSessionFilePath(sessionId);
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(binding, null, 2), "utf8");
      fs.renameSync(tmpPath, filePath);
    } catch (e: any) {
      console.error(`[BindingStore] Failed to save binding to ${filePath}:`, e.message);
    }
  }

  remove(sessionId: string): void {
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
