import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createPromiseClient } from "@connectrpc/connect";
import { LanguageServerService } from "./node_modules/antigravity-client/dist/src/gen/exa/language_server_pb/language_server_connect.js";
import { readAuthData } from "./node_modules/antigravity-client/dist/src/server/auth-reader.js";
import { MockExtensionServer } from "./node_modules/antigravity-client/dist/src/server/mock-extension-server.js";
import { createMetadataBinary } from "./node_modules/antigravity-client/dist/src/server/metadata.js";

const LS = "/opt/Antigravity/resources/bin/language_server";

async function trial(label, extraArgs) {
	const workspacePath = process.cwd();
	const workspaceId = `indie-${path.basename(workspacePath)}`;
	const csrf = randomUUID();
	const geminiDir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-repro-"));

	const auth = readAuthData();
	if (!auth.ussOAuth.value) {
		console.log("no auth data");
		process.exit(1);
	}
	const mock = new MockExtensionServer({ port: 0, authData: auth, verbose: false });
	const mockPort = await mock.start();
	const lsInfo = new Promise((resolve) => mock.once("ls-started", resolve));

	const args = [
		"--extension_server_port", String(mockPort),
		"--workspace_id", workspaceId,
		"--gemini_dir", geminiDir,
		"--app_data_dir", "antigravity_client",
		"--enable_lsp",
		"--enable_sidecars",
		"--subclient_type", "hub",
		"--override_ide_name", "antigravity",
		"--csrf_token", csrf,
		"--http_server_port", "0",
		"--https_server_port", "0",
		"--lsp_port", "0",
		"--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
		...extraArgs,
	];
	const child = spawn(LS, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
	child.stdin.write(createMetadataBinary({ apiKey: mock.apiKey }));
	child.stdin.end();
	child.stdout.on("data", () => {});
	child.stderr.on("data", () => {});

	let info;
	try {
		info = await Promise.race([lsInfo, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000))]);
	} catch (e) {
		console.log(`[${label}] start failed: ${e.message}`);
		child.kill("SIGKILL");
		await mock.stop();
		return null;
	}

	const transport = createConnectTransport({
		baseUrl: `https://127.0.0.1:${info.httpsPort}`,
		httpVersion: "2",
		nodeOptions: { rejectUnauthorized: false },
		interceptors: [(next) => async (req) => {
			req.header.set("x-codeium-csrf-token", csrf);
			return await next(req);
		}],
	});
	const rpc = createPromiseClient(LanguageServerService, transport);

	try {
		const st = await rpc.getUserStatus({});
		const cfgs = st.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
		const labels = cfgs.map((c) => c.label);
		const has38 = labels.some((l) => /3\.8/.test(l ?? ""));
		console.log(`[${label}] models=${cfgs.length} has3.8=${has38}`);
		for (const l of labels) console.log(`    - ${l}`);
		return { count: cfgs.length, has38, labels };
	} catch (e) {
		console.log(`[${label}] getUserStatus failed: ${String(e.message).slice(0, 120)}`);
		return null;
	} finally {
		child.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 800));
		try { child.kill("SIGKILL"); } catch {}
		await mock.stop();
	}
}

console.log("=== baseline (what antigravity-client's Launcher does) ===");
await trial("baseline", []);

console.log("\n=== + --standalone ===");
await trial("standalone", ["--standalone"]);

console.log("\n=== + --standalone --api_server_url --override_ide_version --override_user_agent_name ===");
await trial("desktop-like", [
	"--standalone",
	"--api_server_url", "https://generativelanguage.googleapis.com",
	"--override_ide_version", "2.28.1",
	"--override_user_agent_name", "antigravity",
]);

process.exit(0);