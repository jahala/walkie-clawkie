#!/usr/bin/env node
// walkie-clawkie — push-to-talk between agents. zero deps.
//
//   node walkie.mjs          MCP server (agent-side)
//   node walkie.mjs --relay  HTTP relay (cross-machine radio tower)
//
// Agent mode env:
//   WALKIE_ID       required — agent name
//   WALKIE_RELAY    optional — relay URL for cross-machine
//   WALKIE_ALLOW    optional — comma-separated trusted agent IDs
//   WALKIE_DIR      optional — mailbox root (default /tmp/walkie)
//
// Relay mode env:
//   WALKIE_PORT     optional — listen port (default 4747)
//
import {
  watch, mkdirSync, readdirSync, readFileSync,
  unlinkSync, writeFileSync, existsSync,
} from "fs";
import { join } from "path";
import http from "http";

if (process.argv.includes("--relay")) {
  startRelay();
} else {
  startAgent();
}

// =============================================================================
// RELAY MODE
// =============================================================================

function startRelay() {
  const PORT = parseInt(process.env.WALKIE_PORT ?? "4747");
  const listeners = new Map(); // id → (from, message) => void
  const queues = new Map();    // id → [{ from, message }]

  function body(req) {
    return new Promise((r) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => r(d));
    });
  }

  http.createServer(async (req, res) => {
    const [, action, id] = req.url.split("/");

    // GET /agents
    if (action === "agents") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([...listeners.keys()]));
    }

    // GET /listen/:id — SSE
    if (action === "listen" && id) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");

      const push = (from, message) => {
        res.write(`data: ${JSON.stringify({ from, message })}\n\n`);
      };
      listeners.set(id, push);

      for (const msg of queues.get(id) ?? []) push(msg.from, msg.message);
      queues.delete(id);

      req.on("close", () => listeners.delete(id));
      return;
    }

    // POST /send — { from, to, message }
    if (action === "send" && req.method === "POST") {
      const { from, to, message } = JSON.parse(await body(req));
      const push = listeners.get(to);
      if (push) {
        push(from, message);
      } else {
        const q = queues.get(to) ?? [];
        q.push({ from, message });
        queues.set(to, q);
      }
      res.writeHead(200);
      return res.end("ok");
    }

    res.writeHead(404);
    res.end("not found");
  }).listen(PORT, () => {
    process.stderr.write(`walkie relay on :${PORT}\n`);
  });
}

// =============================================================================
// AGENT MODE
// =============================================================================

function startAgent() {
  const RELAY = process.env.WALKIE_RELAY;
  const DIR = process.env.WALKIE_DIR ?? "/tmp/walkie";
  const ID = process.env.WALKIE_ID;
  if (!ID) { process.stderr.write("WALKIE_ID is required\n"); process.exit(1); }

  const trusted = new Set(
    (process.env.WALKIE_ALLOW ?? "").split(",").filter(Boolean)
  );
  const pending = new Map(); // agent → { from, message }

  // --- mcp protocol ---------------------------------------------------------

  let buf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) handle(JSON.parse(line));
    }
  });

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  function notify(content, meta) {
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  }

  async function handle(msg) {
    if (msg.id === undefined) return; // notifications — ignore

    if (msg.method === "initialize") {
      return reply(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: {},
          experimental: { "claude/channel": {} },
        },
        serverInfo: { name: `walkie-${ID}`, version: "0.1.0" },
        instructions: [
          `You are agent "${ID}". You have a walkie-talkie.`,
          `Incoming messages appear as <channel> tags with a "from" attribute.`,
          `Use walkie_send to talk to other agents. Use walkie_agents to see who's around.`,
          `If an unknown agent tries to contact you, you'll be asked to walkie_allow or walkie_deny them.`,
          `To reach agents on other machines: run "node walkie.mjs --relay" then expose it with "cloudflared tunnel --url http://localhost:4747" (free, no account needed).`,
          `Give the resulting URL to the user so they can pass it to the remote agent as WALKIE_RELAY.`,
        ].join(" "),
      });
    }

    if (msg.method === "tools/list") {
      return reply(msg.id, { tools: TOOLS });
    }

    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      const fn = toolHandlers[name];
      if (!fn) return reply(msg.id, text(`Unknown tool: ${name}`));
      return reply(msg.id, await fn(args));
    }
  }

  // --- tools ----------------------------------------------------------------

  const TOOLS = [
    {
      name: "walkie_send",
      description: "Send a message to another agent",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target agent ID" },
          message: { type: "string", description: "The message" },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "walkie_agents",
      description: "List all agents on the walkie-talkie",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "walkie_allow",
      description: "Allow a pending agent to talk to you",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent ID to allow" },
        },
        required: ["agent"],
      },
    },
    {
      name: "walkie_deny",
      description: "Deny a pending agent's message",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent ID to deny" },
        },
        required: ["agent"],
      },
    },
  ];

  function text(t) {
    return { content: [{ type: "text", text: t }] };
  }

  const toolHandlers = {
    async walkie_send({ to, message }) {
      const ok = await tx.send(to, message);
      return text(ok ? `Sent to ${to}.` : `Agent "${to}" not found.`);
    },
    async walkie_agents() {
      const list = await tx.agents();
      return text(list.join(", ") || "Nobody here.");
    },
    async walkie_allow({ agent }) {
      trusted.add(agent);
      const held = pending.get(agent);
      if (held) {
        pending.delete(agent);
        notify(held.message, { from: held.from });
        return text(`Allowed ${agent}. Their message has been delivered.`);
      }
      return text(`Allowed ${agent}.`);
    },
    async walkie_deny({ agent }) {
      const held = pending.get(agent);
      pending.delete(agent);
      return text(held ? `Denied and dropped message from ${agent}.` : `Nothing pending from ${agent}.`);
    },
  };

  // --- trust gate -----------------------------------------------------------

  function onMessage(from, message) {
    if (trusted.has(from)) {
      notify(message, { from });
    } else {
      pending.set(from, { from, message });
      notify(
        `Agent "${from}" wants to send you a message. Use walkie_allow or walkie_deny.`,
        { from, status: "pending" }
      );
    }
  }

  // --- transport ------------------------------------------------------------

  function localTransport() {
    const inbox = join(DIR, ID, "inbox");
    mkdirSync(inbox, { recursive: true });

    function consume(filepath, filename) {
      try {
        const msg = readFileSync(filepath, "utf-8");
        unlinkSync(filepath);
        const from = filename.match(/from_(.+)\.msg$/)?.[1] ?? "unknown";
        return { from, message: msg };
      } catch { return null; }
    }

    return {
      async send(to, message) {
        const target = join(DIR, to, "inbox");
        if (!existsSync(target)) return false;
        const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        writeFileSync(join(target, `${ts}_from_${ID}.msg`), message);
        return true;
      },
      async agents() {
        return readdirSync(DIR).filter(
          (d) => d !== ID && existsSync(join(DIR, d, "inbox"))
        );
      },
      listen(cb) {
        watch(inbox, (_, f) => {
          if (!f?.endsWith(".msg")) return;
          const r = consume(join(inbox, f), f);
          if (r) cb(r.from, r.message);
        });
      },
      drain(cb) {
        for (const f of readdirSync(inbox).filter((f) => f.endsWith(".msg"))) {
          const r = consume(join(inbox, f), f);
          if (r) cb(r.from, r.message);
        }
      },
    };
  }

  function relayTransport(relay) {
    return {
      async send(to, message) {
        const res = await fetch(`${relay}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: ID, to, message }),
        });
        return res.ok;
      },
      async agents() {
        const res = await fetch(`${relay}/agents`);
        return res.json();
      },
      listen(cb) {
        function connect() {
          http.get(`${relay}/listen/${ID}`, (res) => {
            let buf = "";
            res.on("data", (chunk) => {
              buf += chunk.toString();
              let nl;
              while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data: ")) continue;
                try {
                  const { from, message } = JSON.parse(line.slice(6));
                  cb(from, message);
                } catch {}
              }
            });
            res.on("end", () => setTimeout(connect, 1000));
            res.on("error", (e) => {
              process.stderr.write(`walkie relay error: ${e.message}\n`);
              setTimeout(connect, 1000);
            });
          });
        }
        connect();
      },
      drain() {}, // relay drains on SSE connect
    };
  }

  const tx = RELAY ? relayTransport(RELAY) : localTransport();

  // --- go -------------------------------------------------------------------

  tx.drain(onMessage);
  tx.listen(onMessage);
}
