// Integration test: a paired browser answers a remote MCP call.
// Run with: node --test test/remote.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("remote bridge enforces credentials and forwards modeling calls", { timeout: 30000 }, async (t) => {
    const port = 38000 + Math.floor(Math.random() * 10000);
    const origin = "https://chilicad.home.ayusohaylock.com";
    const pairing = "pairing-" + "a".repeat(48);
    const bearer = "bearer-" + "b".repeat(48);
    const base = "http://127.0.0.1:" + port;
    const child = spawn(process.execPath, ["src/remote.mjs"], {
        env: {
            ...process.env,
            PORT: String(port),
            CHILI_APP_ORIGIN: origin,
            CHILI_PAIRING_TOKEN: pairing,
            CHILI_MCP_BEARER_TOKEN: bearer,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs += data.toString(); });
    child.stderr.on("data", (data) => { logs += data.toString(); });
    t.after(() => child.kill("SIGTERM"));
    let healthy = false;
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error("Bridge exited during startup:\n" + logs);
        try {
            const response = await fetch(base + "/health");
            if (response.ok) { healthy = true; break; }
        } catch { /* awaiting port */ }
        await delay(50);
    }
    assert.ok(healthy, "Bridge never passed /health: " + logs);

    const unauthorized = await fetch(base + "/mcp", { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const forbidden = await fetch(base + "/mcp", {
        method: "POST",
        headers: { Origin: "https://example.com", Authorization: "Bearer " + bearer },
        body: "{}",
    });
    assert.equal(forbidden.status, 403);

    const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws", { origin });
    t.after(() => ws.terminate());
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: pairing }));
    const [auth] = await once(ws, "message");
    assert.equal(JSON.parse(auth.toString()).type, "authenticated");
    ws.send(JSON.stringify({
        type: "hello",
        protocol: 1,
        tools: [{
            name: "get_document_state",
            description: "Read the open CAD document",
            parameters: { type: "object", properties: {} },
        }],
    }));
    ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "call") {
            ws.send(JSON.stringify({
                type: "result",
                id: message.id,
                ok: true,
                content: JSON.stringify({ nodes: [{ name: "test-box" }] }),
            }));
        }
    });
    const transport = new StreamableHTTPClientTransport(
        new URL(base + "/mcp"),
        { requestInit: { headers: { Authorization: "Bearer " + bearer } } },
    );
    const client = new Client({ name: "chili3d-remote-test", version: "1.0.0" });
    t.after(async () => { await client.close(); });
    await client.connect(transport);
    let list = await client.listTools();
    for (let i = 0; i < 20 && !list.tools.some((tool) => tool.name === "chili3d_get_document_state"); i++) {
        await delay(50);
        list = await client.listTools();
    }
    assert.ok(list.tools.some((tool) => tool.name === "chili3d_get_document_state"), "CAD tool missing");
    const output = await client.callTool({ name: "chili3d_get_document_state", arguments: {} });
    assert.equal(output.isError, undefined);
    assert.match(output.content[0].text, /test-box/);
    const generic = await client.callTool({
        name: "chili3d_invoke",
        arguments: { name: "get_document_state", arguments: {} },
    });
    assert.match(generic.content[0].text, /test-box/);
});
