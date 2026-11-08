/**
 * LS Connection Manager
 *
 * Manages connection to Antigravity Language Server (running process or launched standalone).
 */

import { AntigravityClient, type ServerInfo } from "antigravity-client";
import * as path from "node:path";
import * as fs from "node:fs";

export interface LsConnectionOptions {
  workspacePath?: string;
  verbose?: boolean;
}

export class LsConnection {
  private client: (AntigravityClient & { launcher?: any }) | null = null;
  private connectingPromise: Promise<AntigravityClient> | null = null;
  private workspacePath: string;
  private verbose: boolean;

  constructor(options: LsConnectionOptions = {}) {
    this.workspacePath = options.workspacePath || process.cwd();
    this.verbose = options.verbose ?? false;
  }

  setWorkspacePath(wsPath: string) {
    this.workspacePath = wsPath;
  }

  async ensureClient(): Promise<AntigravityClient> {
    if (this.client) {
      try {
        // Quick heartbeat / status check
        await this.client.getUserStatus();
        return this.client;
      } catch {
        // Connection dead, reconnect
        this.client = null;
      }
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.connectOrLaunch().finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  private async connectOrLaunch(): Promise<AntigravityClient> {
    // 1. Try to discover any currently running Antigravity LS
    try {
      const servers: ServerInfo[] = await AntigravityClient.listServers();
      if (servers.length > 0) {
        // Pick the most recent server
        const target = servers[0];
        const client = await AntigravityClient.connectWithServer(target);
        await client.getUserStatus();
        if (this.verbose) {
          console.error(`[LsConnection] Connected to existing LS PID ${target.pid}`);
        }
        this.client = client;
        return client;
      }
    } catch (e: any) {
      if (this.verbose) {
        console.error(`[LsConnection] No running LS found: ${e.message}`);
      }
    }

    // 2. Launch an independent LS process
    if (this.verbose) {
      console.error(`[LsConnection] Launching independent LS for workspace: ${this.workspacePath}`);
    }

    const clientWithLauncher = await AntigravityClient.launch({
      workspacePath: this.workspacePath,
      verbose: this.verbose,
    });

    // Allow Node event loop to exit naturally in one-shot CLI mode (pi -p)
    try {
      (clientWithLauncher.launcher as any).lsProcess?.unref();
      (clientWithLauncher.launcher as any).mockServer?.server?.unref();
    } catch {
      // ignore
    }

    // Monitor crash / exit
    clientWithLauncher.launcher.on("exit", (code: number, signal: string) => {
      if (this.verbose) {
        console.error(`[LsConnection] LS process exited (code=${code}, signal=${signal})`);
      }
      if (this.client === clientWithLauncher) {
        this.client = null;
      }
    });

    this.client = clientWithLauncher;
    return clientWithLauncher;
  }

  getClient(): AntigravityClient | null {
    return this.client;
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        this.client.dispose();
      } catch {
        // ignore
      }
      if (this.client.launcher) {
        try {
          await this.client.launcher.stop();
        } catch {
          // ignore
        }
      }
      this.client = null;
    }
  }
}
