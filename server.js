const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

// peerId -> WebSocket
const peers = new Map();

function broadcast(msg, excludeId = null) {
  const raw = JSON.stringify(msg);
  for (const [id, ws] of peers) {
    if (id !== excludeId && ws.readyState === 1) {
      try { ws.send(raw); } catch (_) {}
    }
  }
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let myId = null;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }

      switch (msg.type) {
        case "register": {
          myId = msg.id;
          peers.set(myId, ws);
          ws.send(JSON.stringify({ type: "registered", id: myId }));
          // Send current peer list
          const list = [...peers.keys()].filter((id) => id !== myId);
          ws.send(JSON.stringify({ type: "peers", list }));
          // Notify others
          broadcast({ type: "peer-joined", id: myId }, myId);
          break;
        }
        case "offer":
        case "answer":
        case "ice": {
          const target = peers.get(msg.to);
          if (target && target.readyState === 1) {
            target.send(JSON.stringify({ ...msg, from: myId }));
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      if (myId) {
        peers.delete(myId);
        broadcast({ type: "peer-left", id: myId });
        myId = null;
      }
    });

    ws.on("error", () => {
      if (myId) {
        peers.delete(myId);
        broadcast({ type: "peer-left", id: myId });
        myId = null;
      }
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`> LocalDrop ready on http://0.0.0.0:${PORT}`);
    console.log(`> Share your LAN IP so other devices can connect`);
  });
});
