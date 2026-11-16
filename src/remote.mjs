// Part of the Chili3D Project. AGPL-3.0. Personal remote deployment adapter.
//
// One authenticated Chili3D browser owns the CAD document. This server exposes its
// tool registry over authenticated, stateless Streamable HTTP for remote MCP clients.
// It deliberately leaves the upstream loopback daemon and stdio entrypoint intact.

import { timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.PORT || "3000");
const APP_ORIGIN = process.env.CHILI_APP_ORIGIN;
const PAIRING_TOKEN = process.env.CHILI_PAIRING_TOKEN;
const MCP_TOKEN = process.env.CHILI_MCP_BEARER_TOKEN;
const PROTOCOL = 1;
const TIMEOUT_MS = 180_000;
const MAX_BYTES = 4 * 1024 * 1024;

if (!APP_ORIGIN || !PAIRING_TOKEN || !MCP_TOKEN) {
    throw new Error("CHILI_APP_ORIGIN, CHILI_PAIRING_TOKEN and CHILI_MCP_BEARER_TOKEN are required");
}
const appUrl = new URL(APP_ORIGIN);
if (appUrl.protocol !== "https:" || appUrl.origin !== APP_ORIGIN) {
    throw new Error("CHILI_APP_ORIGIN must be an HTTPS origin without a path");
}
if (PAIRING_TOKEN.length < 32 || MCP_TOKEN.length < 32) {
    throw new Error("Bridge credentials must contain at least 32 characters");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port");
}

function safeEqual(value, expected) {
    if (typeof value !== "string") return false;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

let browser;
let tools = [];
let toolMap = new Map();
let busy;
let queue = Promise.resolve();
const pending = new Map();

function health() {
    return { ok: true, connected: Boolean(browser), toolCount: tools.length, busy: busy?.name ?? null };
}
function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}
function failPending(message) {
    for (const [id, item] of pending) {
        clearTimeout(item.timer);
        item.resolve({ ok: false, content: message });
        pending.delete(id);
    }
}
function callPage(name, args) {
    const job = queue.then(() => callPageNow(name, args));
    queue = job.then(() => undefined, () => undefined);
    return job;
}
function callPageNow(name, args) {
    if (!browser || browser.readyState !== 1) {
        return Promise.resolve({ ok: false, content: "No authenticated Chili3D editor is connected." });
    }
    if (busy) return Promise.resolve({ ok: false, content: "Timed-out operation still running: " + busy.name });
    const ws = browser;
    const id = randomUUID();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            if (browser === ws) busy = { id, name };
            resolve({ ok: false, content: "CAD operation timed out; wait for completion or reconnect editor." });
        }, TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        try {
            ws.send(JSON.stringify({ type: "call", id, name, args }));
        } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            resolve({ ok: false, content: String(error) });
        }
    });
}
function asMcp(reply) {
    if (!reply?.ok) {
        return { isError: true, content: [{ type: "text", text: reply?.content ?? "CAD operation failed" }] };
    }
    const text = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content ?? {});
    const content = [{ type: "text", text }];
    for (const item of reply.images ?? []) {
        if (item.mediaType === "image/png" || item.mediaType === "image/jpeg") {
            content.push({ type: "image", data: item.data, mimeType: item.mediaType });
        }
    }
    return { content };
}
const emptySchema = { type: "object", properties: {} };
function visibleTools() {
    const pageTools = tools.map((tool) => ({
        name: "chili3d_" + tool.name,
        description: String(tool.description ?? "").slice(0, 2048),
        inputSchema: tool.parameters?.type === "object" ? tool.parameters : emptySchema,
    }));
    return [
        {
            name: "chili3d_status",
            description: "Check connection to the live Chili3D editor and availability of modeling tools.",
            inputSchema: emptySchema,
        },
        {
            name: "chili3d_list_tools",
            description: "List the current editor's modeling tools and input schemas; works after connecting the browser.",
            inputSchema: emptySchema,
        },
        {
            name: "chili3d_invoke",
            description: "Invoke a named modeling tool discovered with chili3d_list_tools. Use when tools are not dynamically relisted by the MCP client.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    arguments: { type: "object", additionalProperties: true },
                },
                required: ["name"],
            },
        },
        ...pageTools,
    ];
}
function makeMcpServer() {
    const server = new Server(
        { name: "chili3d-remote", version: "0.1.0" },
        { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: visibleTools() }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const requestName = params.name;
        if (requestName === "chili3d_status") return asMcp({ ok: true, content: health() });
        if (requestName === "chili3d_list_tools") {
            return asMcp({ ok: true, content: visibleTools().slice(3) });
        }
        const name = requestName === "chili3d_invoke"
            ? params.arguments?.name
            : requestName.startsWith("chili3d_") ? requestName.slice(8) : null;
        const args = requestName === "chili3d_invoke"
            ? params.arguments?.arguments ?? {}
            : params.arguments ?? {};
        if (typeof name !== "string" || !toolMap.has(name)) {
            return asMcp({ ok: false, content: "Unknown or unavailable Chili3D tool: " + String(name) });
        }
        return asMcp(await callPage(name, args));
    });
    return server;
}

async function parseBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error("MCP request body too large");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const httpServer = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") {
        return json(res, 200, { ok: true });
    }
    if (path !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.headers.origin) return json(res, 403, { error: "browser requests prohibited" });
    if (!safeEqual(req.headers.authorization?.replace(/^Bearer /i, ""), MCP_TOKEN)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return json(res, 401, { error: "unauthorized" });
    }
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: "POST required for stateless MCP" });
    }
    let mcp;
    let transport;
    try {
        const body = await parseBody(req);
        mcp = makeMcpServer();
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.once("close", () => {
            void transport.close();
            void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
    } catch (error) {
        if (!res.headersSent) json(res, 400, { error: String(error) });
    }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
httpServer.on("upgrade", (req, socket, head) => {
    let url;
    try {
        url = new URL(req.url ?? "/", "http://localhost");
    } catch {
        socket.destroy();
        return;
    }
    if (url.pathname !== "/ws" || url.search || req.headers.origin !== APP_ORIGIN) {
        socket.destroy();
        return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
});
sockets.on("connection", (ws) => {
    let authenticated = false;
    let helloReceived = false;
    const timer = setTimeout(() => ws.close(4001, "pairing timeout"), 10_000);
    ws.on("error", () => ws.terminate());
    ws.on("message", (buffer) => {
        let msg;
        try { msg = JSON.parse(buffer.toString()); } catch { ws.close(4003, "invalid JSON"); return; }
        if (!authenticated) {
            if (msg.type !== "auth" || !safeEqual(msg.token, PAIRING_TOKEN)) {
                ws.close(4001, "invalid pairing secret");
                return;
            }
            authenticated = true;
            clearTimeout(timer);
            ws.send(JSON.stringify({ type: "authenticated" }));
            return;
        }
        if (msg.type === "hello" && !helloReceived) {
            if (msg.protocol !== PROTOCOL || !Array.isArray(msg.tools)) {
                ws.close(4003, "invalid protocol or tool list");
                return;
            }
            const descriptors = msg.tools.filter((item) =>
                item && typeof item.name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item.name),
            ).slice(0, 100);
            if (browser && browser !== ws) {
                failPending("Editor was replaced by a different browser session");
                browser.close(4002, "replaced by newer editor");
            }
            browser = ws;
            helloReceived = true;
            busy = undefined;
            tools = descriptors;
            toolMap = new Map(tools.map((tool) => [tool.name, tool]));
            return;
        }
        if (!helloReceived || msg.type !== "result") return;
        if (busy?.id === msg.id) busy = undefined;
        const item = pending.get(msg.id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(msg.id);
        item.resolve(msg);
    });
    ws.on("close", () => {
        clearTimeout(timer);
        if (browser !== ws) return;
        browser = undefined;
        busy = undefined;
        tools = [];
        toolMap.clear();
        failPending("Chili3D editor disconnected");
    });
});
const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
    }
}, 30_000);
sockets.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
});
httpServer.listen(PORT, "0.0.0.0", () => {
    console.log("Chili3D remote bridge listening on port " + PORT);
    console.log("Allowed browser origin: " + APP_ORIGIN);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        clearInterval(heartbeat);
        for (const ws of sockets.clients) ws.terminate();
        httpServer.close(() => process.exit(0));
    });
}
