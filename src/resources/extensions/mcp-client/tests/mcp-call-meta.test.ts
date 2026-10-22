/**
 * Regression test for #1792 — mcp_call must attach replay-stable request _meta
 * on CallTool so servers that require io.opengsd/idempotency-key or
 * claudecode/toolUseId can accept mutations.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mcpClientExtension, { _mcpCallTimeoutMsForTest, _resetMcpClientStateForTest } from "../index.js";

function createMockPi(): { pi: unknown; tools: Map<string, any> } {
	const tools = new Map<string, any>();
	return {
		tools,
		pi: {
			on() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		},
	};
}

test("mcp_call CallTool request params include replay-stable _meta (#1792)", async () => {
	const previousGsdHome = process.env.GSD_HOME;
	const originalCwd = process.cwd();
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-call-meta-project-"));
	const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-call-meta-home-"));

	try {
		process.env.GSD_HOME = gsdHomeDir;
		process.chdir(projectDir);
		mkdirSync(join(projectDir, ".gsd"), { recursive: true });

		const require = createRequire(import.meta.url);
		const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
		const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
		const serverPath = join(projectDir, "echo-meta-mcp-server.mjs");
		writeFileSync(
			serverPath,
			[
				`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
				`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
				'const server = new McpServer({ name: "echo-meta", version: "1.0.0" }, { capabilities: { tools: {} } });',
				'server.tool("echo_meta", "Echo request _meta", {}, async (_args, extra) => ({',
				'  content: [{ type: "text", text: JSON.stringify(extra?._meta ?? null) }],',
				"}));",
				"await server.connect(new StdioServerTransport());",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"echo-meta": { command: process.execPath, args: [serverPath] },
				},
			}),
			"utf-8",
		);

		const { pi, tools } = createMockPi();
		mcpClientExtension(pi as any);
		const mcpCall = tools.get("mcp_call");
		assert.ok(mcpCall, "mcp_call must be registered");

		const ctx = {
			hasUI: true,
			ui: {
				confirm: async () => true,
			},
		};
		const toolCallId = "tool-call-1792";
		const result = await mcpCall.execute(
			toolCallId,
			{ server: "echo-meta", tool: "echo_meta", args: {} },
			new AbortController().signal,
			() => {},
			ctx,
		);

		const meta = JSON.parse(result.content[0]?.text ?? "");
		assert.notEqual(meta, null);
		assert.equal(typeof meta, "object");
		assert.equal(meta["claudecode/toolUseId"], toolCallId);
		assert.equal(meta["io.opengsd/idempotency-key"], `pi:${toolCallId}`);
	} finally {
		await _resetMcpClientStateForTest();
		process.chdir(originalCwd);
		if (previousGsdHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousGsdHome;
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(gsdHomeDir, { recursive: true, force: true });
	}
});

test("mcp_call gives the workflow server's gsd_exec and gsd_uat_exec the exec clamp plus a minute", () => {
	const execDeadline = 3_600_000 + 60_000;
	for (const tool of ["gsd_exec", "gsd_uat_exec"]) {
		assert.equal(_mcpCallTimeoutMsForTest("gsd-workflow", {}, tool), execDeadline, `${tool} default`);
		assert.equal(_mcpCallTimeoutMsForTest("gsd-workflow", { GSD_MCP_WORKFLOW_TIMEOUT_MS: "100" }, tool), execDeadline);
		assert.equal(
			_mcpCallTimeoutMsForTest("gsd-workflow", { GSD_MCP_WORKFLOW_TIMEOUT_MS: "7200000" }, tool),
			7_200_000,
			"a longer configured deadline is kept",
		);
		assert.equal(_mcpCallTimeoutMsForTest("gsd-workflow", { GSD_MCP_WORKFLOW_TIMEOUT_MS: "0" }, tool), 2_147_483_647);
		assert.equal(_mcpCallTimeoutMsForTest("other", {}, tool), 60_000, "other servers keep the plain MCP timeout");
	}
	assert.equal(_mcpCallTimeoutMsForTest("gsd-workflow", {}, "gsd_plan_slice"), 5 * 60 * 1000);
	assert.equal(_mcpCallTimeoutMsForTest("gsd-workflow", { GSD_MCP_WORKFLOW_TIMEOUT_MS: "100" }, "gsd_plan_slice"), 100);
});

test("mcp_call uses the workflow server timeout only for the gsd-workflow server", async () => {
	const previousGsdHome = process.env.GSD_HOME;
	const previousTimeout = process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS;
	const previousWorkflowName = process.env.GSD_WORKFLOW_MCP_NAME;
	const originalCwd = process.cwd();
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-call-timeout-project-"));
	const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-call-timeout-home-"));

	try {
		process.env.GSD_HOME = gsdHomeDir;
		delete process.env.GSD_WORKFLOW_MCP_NAME;
		process.chdir(projectDir);
		mkdirSync(join(projectDir, ".gsd"), { recursive: true });

		const require = createRequire(import.meta.url);
		const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
		const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
		const serverPath = join(projectDir, "slow-mcp-server.mjs");
		writeFileSync(
			serverPath,
			[
				`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
				`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
				'const server = new McpServer({ name: "slow", version: "1.0.0" }, { capabilities: { tools: {} } });',
				'server.tool("slow_write", "Commit after a delay", {}, async () => {',
				"  await new Promise((resolve) => setTimeout(resolve, 500));",
				'  return { content: [{ type: "text", text: "committed" }] };',
				"});",
				"await server.connect(new StdioServerTransport());",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"gsd-workflow": { command: process.execPath, args: [serverPath] },
					other: { command: process.execPath, args: [serverPath] },
				},
			}),
			"utf-8",
		);

		const { pi, tools } = createMockPi();
		mcpClientExtension(pi as any);
		const mcpCall = tools.get("mcp_call");
		assert.ok(mcpCall, "mcp_call must be registered");
		const ctx = { hasUI: true, ui: { confirm: async () => true } };
		const call = (server: string, id: string) => mcpCall.execute(
			id,
			{ server, tool: "slow_write", args: {} },
			new AbortController().signal,
			() => {},
			ctx,
		);

		process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS = "100";
		await assert.rejects(call("gsd-workflow", "timeout-short"), /timed out/i);
		await assert.rejects(call("GSD-Workflow", "timeout-short-case"), /timed out/i);
		await assert.rejects(call(" gsd-workflow", "timeout-short-space"), /timed out/i);
		const other = await call("other", "timeout-other");
		assert.equal(other.content[0]?.text, "committed");

		process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS = "5000";
		const result = await call("gsd-workflow", "timeout-long");
		assert.equal(result.content[0]?.text, "committed");
	} finally {
		await _resetMcpClientStateForTest();
		process.chdir(originalCwd);
		if (previousGsdHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousGsdHome;
		if (previousTimeout === undefined) delete process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS;
		else process.env.GSD_MCP_WORKFLOW_TIMEOUT_MS = previousTimeout;
		if (previousWorkflowName === undefined) delete process.env.GSD_WORKFLOW_MCP_NAME;
		else process.env.GSD_WORKFLOW_MCP_NAME = previousWorkflowName;
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(gsdHomeDir, { recursive: true, force: true });
	}
});

test("mcp_call asks the workflow server for progress on gsd_exec and gsd_uat_exec only", async (t) => {
	const previousGsdHome = process.env.GSD_HOME;
	const previousWorkflowName = process.env.GSD_WORKFLOW_MCP_NAME;
	const originalCwd = process.cwd();
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-call-progress-project-"));
	const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-call-progress-home-"));
	t.after(async () => {
		await _resetMcpClientStateForTest();
		process.chdir(originalCwd);
		if (previousGsdHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousGsdHome;
		if (previousWorkflowName === undefined) delete process.env.GSD_WORKFLOW_MCP_NAME;
		else process.env.GSD_WORKFLOW_MCP_NAME = previousWorkflowName;
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(gsdHomeDir, { recursive: true, force: true });
	});
	process.env.GSD_HOME = gsdHomeDir;
	delete process.env.GSD_WORKFLOW_MCP_NAME;
	process.chdir(projectDir);
	mkdirSync(join(projectDir, ".gsd"), { recursive: true });

	const require = createRequire(import.meta.url);
	const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
	const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
	const serverPath = join(projectDir, "progress-mcp-server.mjs");
	writeFileSync(
		serverPath,
		[
			`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
			`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
			'const server = new McpServer({ name: "progress", version: "1.0.0" }, { capabilities: { tools: {} } });',
			'for (const name of ["gsd_exec", "gsd_uat_exec", "gsd_plan_slice"]) {',
			"  server.tool(name, \"Report whether progress was asked for\", {}, async (_args, extra) => ({",
			'    content: [{ type: "text", text: extra?._meta?.progressToken === undefined ? "no-progress" : "progress" }],',
			"  }));",
			"}",
			"await server.connect(new StdioServerTransport());",
		].join("\n"),
		"utf-8",
	);
	writeFileSync(
		join(projectDir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				"gsd-workflow": { command: process.execPath, args: [serverPath] },
				other: { command: process.execPath, args: [serverPath] },
			},
		}),
		"utf-8",
	);

	const { pi, tools } = createMockPi();
	mcpClientExtension(pi as any);
	const mcpCall = tools.get("mcp_call");
	assert.ok(mcpCall, "mcp_call must be registered");
	const ctx = { hasUI: true, ui: { confirm: async () => true } };
	const call = async (server: string, tool: string) => {
		const result = await mcpCall.execute(`progress-${server}-${tool}`, { server, tool, args: {} }, new AbortController().signal, () => {}, ctx);
		return result.content[0]?.text;
	};

	assert.equal(await call("gsd-workflow", "gsd_exec"), "progress");
	assert.equal(await call("gsd-workflow", "gsd_uat_exec"), "progress");
	assert.equal(await call("gsd-workflow", "gsd_plan_slice"), "no-progress");
	assert.equal(await call("other", "gsd_exec"), "no-progress");
});
