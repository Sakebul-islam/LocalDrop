/**
 * LocalDrop Signaling Server — deploy this to Railway / Render / Fly.io (free tier)
 * Then set NEXT_PUBLIC_SIGNAL_SERVER=wss://your-app.railway.app/ws in Netlify env vars.
 */
const { createServer } = require("http");
const { WebSocketServer } = require("ws");

const peers = new Map(); // id -> WebSocket

function send(ws, msg) {
  if (ws.readyState === 1) try { ws.send(JSON.stringify(msg)); } catch {}
}

function broadcast(msg, excludeId = null) {
  for (const [id, ws] of peers)
    if (id !== excludeId) send(ws, msg);
}

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end("LocalDrop Signal Server");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let myId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "register":
        myId = msg.id;
        peers.set(myId, ws);
        send(ws, { type: "registered", id: myId });
        send(ws, { type: "peers", list: [...peers.keys()].filter((id) => id !== myId) });
        broadcast({ type: "peer-joined", id: myId }, myId);
        break;
      case "offer":
      case "answer":
      case "ice": {
        const target = peers.get(msg.to);
        if (target) send(target, { ...msg, from: myId });
        break;
      }
    }
  });

  function cleanup() {
    if (!myId) return;
    peers.delete(myId);
    broadcast({ type: "peer-left", id: myId });
    myId = null;
  }
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`LocalDrop signal server ready on port ${PORT}`);
});
