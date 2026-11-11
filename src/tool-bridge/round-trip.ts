/**
 * Round-trip store for parking MCP tool calls until pi executes them.
 */

import { EventEmitter } from "node:events";

export interface ParkedCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  parkedAt: number;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

export interface ParkEvent {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export class RoundTrip extends EventEmitter {
  private parkedCalls = new Map<string, ParkedCall>();

  /**
   * Park an incoming MCP tools/call request.
   * Emits "park" event so provider-stream can emit tool_use and end stream.
   * Resolves when pi finishes executing the tool and calls resolve().
   */
  park(callId: string, toolName: string, args: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const entry: ParkedCall = {
        callId,
        toolName,
        args,
        parkedAt: Date.now(),
        resolve,
        reject,
      };
      this.parkedCalls.set(callId, entry);

      // Notify provider-stream
      this.emit("park", { callId, toolName, args } satisfies ParkEvent);
    });
  }

  /**
   * Resolve a parked tool call with the result from pi's execution.
   */
  resolve(callId: string, result: any): boolean {
    const entry = this.parkedCalls.get(callId);
    if (!entry) return false;

    this.parkedCalls.delete(callId);
    entry.resolve(result);
    return true;
  }

  /**
   * Reject a parked tool call with an error.
   */
  reject(callId: string, error: Error): boolean {
    const entry = this.parkedCalls.get(callId);
    if (!entry) return false;

    this.parkedCalls.delete(callId);
    entry.reject(error);
    return true;
  }

  /**
   * Abort all pending tool calls (e.g., when the turn is cancelled).
   */
  abortAll(reason = "Turn aborted"): void {
    const err = new Error(reason);
    for (const [callId, entry] of this.parkedCalls.entries()) {
      entry.reject(err);
    }
    this.parkedCalls.clear();
  }

  hasParkedCalls(): boolean {
    return this.parkedCalls.size > 0;
  }

  getParkedCount(): number {
    return this.parkedCalls.size;
  }

  getPendingCalls(): Array<{ callId: string; toolName: string; args: Record<string, unknown> }> {
    return Array.from(this.parkedCalls.values()).map((p) => ({
      callId: p.callId,
      toolName: p.toolName,
      args: p.args,
    }));
  }
}
