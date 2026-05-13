"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CloudArrowUp, FolderOpen, Laptop } from "@phosphor-icons/react";

// ─── Constants ────────────────────────────────────────────────────────────────
const CHUNK_SIZE   = 64  * 1024;
const SEGMENT_SIZE = 16  * 1024 * 1024;
const HIGHWATER    = 4   * 1024 * 1024;
const LOWWATER     = 256 * 1024;
const ICE_SERVERS  = [{ urls: "stun:stun.l.google.com:19302" }];

// When this env var is set, the app uses direct WebSocket signaling (full LAN speed).
// Without it, PeerJS is used as fallback (works everywhere, limited by public relay speed).
const SIGNAL_SERVER = process.env.NEXT_PUBLIC_SIGNAL_SERVER ?? null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId() {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let r = "";
  for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function formatBytes(b: number) {
  if (!b) return "0 B";
  const k = 1024, i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(2)} ${["B","KB","MB","GB","TB"][i]}`;
}

// ─── LAN room ID (PeerJS hub/spoke only) ─────────────────────────────────────
async function getLanRoomId(): Promise<string> {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.createDataChannel("x");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve("LDROPNET0"));

    // Prefer srflx (public IP from STUN) — identical for every device behind
    // the same router whether they use WiFi or Ethernet.  subnet hash is only
    // used as a last-resort fallback so wired and wireless peers always agree.
    let srflxId:  string | null = null;
    let subnetId: string | null = null;
    let done = false;

    const hash = (s: string) => {
      let h = 0;
      for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
      return "LD" + Math.abs(h).toString(36).toUpperCase().slice(0, 5);
    };
    const finish = (id: string) => { if (!done) { done = true; pc.close(); resolve(id); } };

    setTimeout(() => finish(srflxId ?? subnetId ?? "LDROPNET0"), 4000);

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) { finish(srflxId ?? subnetId ?? "LDROPNET0"); return; }
      const parts = candidate.candidate.split(" ");
      const ip = parts[4], type = parts[7];
      if (type === "srflx" && /^(\d+\.){3}\d+$/.test(ip) && !srflxId) {
        srflxId = hash(ip);
        setTimeout(() => finish(srflxId ?? subnetId ?? "LDROPNET0"), 800);
      } else if (type === "host" && /^(\d+\.){3}\d+$/.test(ip) && !ip.startsWith("127.") && !subnetId) {
        // Store as fallback only — do NOT finish() yet so srflx can still arrive
        subnetId = hash(ip.split(".").slice(0, 3).join("."));
      }
    };
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Toast    { id: number; msg: string; type: "info"|"success"|"error"; }
interface LogEntry { id: number; direction: "Sent"|"Received"; name: string; size: number; url?: string; }
interface FileMeta { name: string; size: number; mime: string; }

// ─── Component ────────────────────────────────────────────────────────────────
export default function Page() {
  const myIdRef = useRef(genId());

  // Signaling refs
  const wsRef      = useRef<WebSocket | null>(null);          // WS mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peerRef    = useRef<any>(null);                       // PeerJS mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pjsConnRef = useRef<any>(null);                       // PeerJS DataConnection
  const rtcPcRef   = useRef<RTCPeerConnection | null>(null);  // WS mode RTCPeerConnection

  // Shared connection state
  const dc           = useRef<RTCDataChannel | null>(null);
  const connTimeout  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hub/spoke LAN discovery (PeerJS mode only)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hubPeerRef   = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hubClientMap = useRef(new Map<string, any>());
  const lanRoomId    = useRef<string | null>(null);
  const isHub        = useRef(false);

  // Transfer state
  const sendFileRef      = useRef<File | null>(null);
  const receiveMeta      = useRef<FileMeta | null>(null);
  const receiveStream    = useRef<FileSystemWritableFileStream | null>(null);
  const receiveBuffer    = useRef<ArrayBuffer[]>([]);
  const receivedSize     = useRef(0);
  const receiveStartTime = useRef(0);
  const lastReceiveUI    = useRef(0);
  const recvWindowBytes  = useRef(0);
  const recvWindowStart  = useRef(0);

  // UI state
  const [myId, setMyId]              = useState(myIdRef.current);
  const [status, setStatus]          = useState<"connecting"|"online"|"error">("connecting");
  const [connectedPeer, setConnected]= useState<string | null>(null);
  const [peers, setPeers]            = useState<string[]>([]);
  const [toasts, setToasts]          = useState<Toast[]>([]);
  const [logs, setLogs]              = useState<LogEntry[]>([]);
  const [targetInput, setTarget]     = useState("");
  const [connecting, setConnecting]  = useState(false);
  const [incomingFile, setIncoming]   = useState<FileMeta | null>(null);
  const [sendProgress, setSendProgress] = useState<{ pct: number; label: string } | null>(null);
  const [recvProgress, setRecvProgress] = useState<{ pct: number; label: string } | null>(null);
  const [isHubState, setIsHubState]   = useState(false);

  const toastId = useRef(0);
  const logId   = useRef(0);

  const addToast = useCallback((msg: string, type: Toast["type"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const addLog = useCallback((direction: LogEntry["direction"], name: string, size: number, url?: string) => {
    setLogs((l) => [{ id: ++logId.current, direction, name, size, url }, ...l]);
  }, []);

  const showSendProgress = useCallback((current: number, total: number, label: string) => {
    setSendProgress({ pct: Math.min(100, Math.round((current / total) * 100)), label });
  }, []);
  const hideSendProgress = useCallback(() => setSendProgress(null), []);

  const showRecvProgress = useCallback((current: number, total: number, label: string) => {
    setRecvProgress({ pct: Math.min(100, Math.round((current / total) * 100)), label });
  }, []);
  const hideRecvProgress = useCallback(() => setRecvProgress(null), []);

  const resetConnection = useCallback((intentional = false) => {
    dc.current = null;
    pjsConnRef.current?.close();  pjsConnRef.current = null;
    rtcPcRef.current?.close();    rtcPcRef.current = null;
    if (connTimeout.current) clearTimeout(connTimeout.current);
    setConnected(null);
    setConnecting(false);
    hideSendProgress();
    hideRecvProgress();
    if (intentional) sessionStorage.removeItem("ld_peer");
  }, [hideSendProgress, hideRecvProgress]);

  // ─── Shared: incoming data handler ────────────────────────────────────────
  const handleData = useCallback(async (data: unknown) => {
    if (typeof data === "string") {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data as string); } catch { return; }

      if (msg.type === "header") {
        const m = msg as unknown as FileMeta & { type: string };
        receiveMeta.current = { name: m.name, size: m.size, mime: m.mime };
        setIncoming({ name: m.name, size: m.size, mime: m.mime });
      } else if (msg.type === "accept") {
        addToast("Accepted! Sending…", "success");
        startSendingChunks();
      } else if (msg.type === "decline") {
        addToast("Peer declined.", "error");
        sendFileRef.current = null;
      } else if (msg.type === "end") {
        const meta = receiveMeta.current!;
        if (receiveStream.current) {
          await receiveStream.current.close();
          addLog("Received", meta.name, meta.size);
          addToast(`Saved ${meta.name}!`, "success");
        } else {
          const blob = new Blob(receiveBuffer.current, { type: meta.mime });
          addLog("Received", meta.name, meta.size, URL.createObjectURL(blob));
          addToast(`${meta.name} ready — click Download!`, "success");
        }
        showRecvProgress(meta.size, meta.size, "Received ✓");
        setTimeout(hideRecvProgress, 1200);
        receiveMeta.current = null; receiveBuffer.current = []; receiveStream.current = null; receivedSize.current = 0;
      }
    } else {
      const buf: ArrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data as ArrayBuffer;
      receivedSize.current  += buf.byteLength;
      recvWindowBytes.current += buf.byteLength;
      const now = Date.now();
      if (now - lastReceiveUI.current >= 80) {
        lastReceiveUI.current = now;
        const windowSec = (now - recvWindowStart.current) / 1000 || 0.001;
        const speed = windowSec >= 0.4
          ? recvWindowBytes.current / windowSec
          : receivedSize.current / ((now - receiveStartTime.current) / 1000 || 0.001);
        if (windowSec >= 0.4) { recvWindowBytes.current = 0; recvWindowStart.current = now; }
        showRecvProgress(receivedSize.current, receiveMeta.current!.size, `Receiving • ${formatBytes(speed)}/s`);
      }
      if (receiveStream.current) void receiveStream.current.write(buf);
      else receiveBuffer.current.push(buf);
    }
  }, [addLog, addToast, hideRecvProgress, showRecvProgress]);

  // ─── Shared: high-throughput sender ───────────────────────────────────────
  async function startSendingChunks() {
    const file = sendFileRef.current, ch = dc.current;
    if (!file || !ch) return;
    let offset = 0;
    const startTime = Date.now();
    ch.bufferedAmountLowThreshold = LOWWATER;
    showSendProgress(0, file.size, "Sending • starting…");
    let lastUI = Date.now(), windowBytes = 0, windowStart = Date.now();

    try {
      while (offset < file.size) {
        const segEnd  = Math.min(offset + SEGMENT_SIZE, file.size);
        const segment = await file.slice(offset, segEnd).arrayBuffer();
        const view    = new Uint8Array(segment);
        let segPos    = 0;
        while (segPos < view.byteLength) {
          if (ch.bufferedAmount >= HIGHWATER) {
            await new Promise<void>((res) => {
              ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); };
            });
          }
          const end  = Math.min(segPos + CHUNK_SIZE, view.byteLength);
          const sent = end - segPos;
          ch.send(view.subarray(segPos, end));
          offset += sent; segPos = end; windowBytes += sent;
          const now = Date.now();
          if (now - lastUI >= 80) {
            lastUI = now;
            const windowSec = (now - windowStart) / 1000 || 0.001;
            const speed = windowSec >= 0.4 ? windowBytes / windowSec : offset / ((now - startTime) / 1000 || 0.001);
            if (windowSec >= 0.4) { windowBytes = 0; windowStart = now; }
            showSendProgress(offset, file.size, `Sending • ${formatBytes(speed)}/s`);
          }
        }
      }
    } catch (err: unknown) {
      addToast(`Send error: ${err instanceof Error ? err.message : String(err)}`, "error");
      hideSendProgress(); sendFileRef.current = null; return;
    }
    showSendProgress(file.size, file.size, "Sent ✓");
    ch.send(JSON.stringify({ type: "end" }));
    addToast("Transfer complete!", "success");
    addLog("Sent", file.name, file.size);
    setTimeout(hideSendProgress, 1200);
    sendFileRef.current = null;
  }

  // ─── Reload protection: warn before closing when a channel is live ────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dc.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ─── Shared: set up a raw RTCDataChannel ──────────────────────────────────
  const setupChannel = useCallback((ch: RTCDataChannel, peerId: string) => {
    if (connTimeout.current) clearTimeout(connTimeout.current);
    ch.binaryType = "arraybuffer";
    ch.onmessage = (e) => handleData(e.data);
    ch.onclose   = () => { resetConnection(); addToast("Disconnected.", "info"); };
    ch.onerror   = () => { addToast("Connection error.", "error"); resetConnection(); };
    dc.current = ch;
    sessionStorage.setItem("ld_peer", peerId); // persist for reload recovery
    setConnected(peerId);
    setConnecting(false);
    addToast("Connected!", "success");
  }, [addToast, handleData, resetConnection]);

  // ─── WS mode: create RTCPeerConnection ────────────────────────────────────
  const createWsPC = useCallback((peerId: string) => {
    rtcPcRef.current?.close();
    const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    rtcPcRef.current = p;
    p.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(JSON.stringify({ type: "ice", to: peerId, candidate: ev.candidate.toJSON() }));
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === "failed") { addToast("Connection failed.", "error"); resetConnection(); }
    };
    return p;
  }, [addToast, resetConnection]);

  // ─── WS mode: signaling init ───────────────────────────────────────────────
  const initWsMode = useCallback((url: string) => {
    const socket = new WebSocket(url);
    wsRef.current = socket;
    let pendingPeerId = "";

    socket.onopen = () => socket.send(JSON.stringify({ type: "register", id: myIdRef.current }));

    socket.onmessage = async (e) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case "registered":
          setMyId(msg.id as string); myIdRef.current = msg.id as string;
          setStatus("online");
          {
            const prevPeer = sessionStorage.getItem("ld_peer");
            if (prevPeer) { sessionStorage.removeItem("ld_peer"); setTimeout(() => connectToPeer(prevPeer), 600); }
          }
          break;
        case "peers":
          setPeers((msg.list as string[]).filter((id) => id !== myIdRef.current)); break;
        case "peer-joined":
          if (msg.id !== myIdRef.current)
            setPeers((p) => p.includes(msg.id as string) ? p : [...p, msg.id as string]);
          break;
        case "peer-left":
          setPeers((p) => p.filter((id) => id !== msg.id)); break;
        case "offer": {
          pendingPeerId = msg.from as string;
          const p = createWsPC(pendingPeerId);
          p.ondatachannel = (ev) => {
            if (ev.channel.label === "file-transfer") setupChannel(ev.channel, pendingPeerId);
          };
          await p.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
          const answer = await p.createAnswer();
          await p.setLocalDescription(answer);
          socket.send(JSON.stringify({ type: "answer", to: pendingPeerId, sdp: answer }));
          break;
        }
        case "answer":
          if (rtcPcRef.current) await rtcPcRef.current.setRemoteDescription(
            new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
          break;
        case "ice":
          if (rtcPcRef.current) try {
            await rtcPcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
          } catch { /* ignore race */ }
          break;
      }
    };

    socket.onerror  = () => setStatus("error");
    socket.onclose  = () => {
      setStatus("error");
      setTimeout(() => initWsMode(url), 3000);
    };
  }, [createWsPC, setupChannel]);

  // ─── PeerJS mode: bind PeerJS DataConnection ──────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bindPeerConn = useCallback((conn: any, peerId: string) => {
    pjsConnRef.current = conn;
    conn.on("open", () => {
      const ch: RTCDataChannel = conn.dataChannel;
      setupChannel(ch, peerId);
    });
    conn.on("close", () => { resetConnection(); addToast("Disconnected.", "info"); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conn.on("error", (err: any) => { addToast(`Error: ${err?.message ?? ""}`, "error"); resetConnection(); });
  }, [addToast, resetConnection, setupChannel]);

  // ─── PeerJS mode: hub/spoke LAN discovery ─────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tryBeHub = useCallback((roomId: string, Peer: any) => {
    lanRoomId.current = roomId;
    const hp = new Peer(roomId, { config: { iceServers: ICE_SERVERS } });
    hubPeerRef.current = hp;
    hp.on("open", () => {
      isHub.current = true; setIsHubState(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hp.on("connection", (conn: any) => {
        conn.on("open", () => {
          conn.on("data", (raw: string) => {
            try {
              const msg = JSON.parse(raw);
              if (msg.type === "hello") {
                const clientId: string = msg.id;
                hubClientMap.current.set(clientId, conn);
                const list = [myIdRef.current, ...Array.from(hubClientMap.current.keys())].filter((id) => id !== clientId);
                conn.send(JSON.stringify({ type: "peers", list }));
                hubBroadcast({ type: "join", id: clientId }, [clientId]);
                setPeers((p) => p.includes(clientId) ? p : [...p, clientId]);
              }
            } catch { /* ignore */ }
          });
          conn.on("close", () => {
            let leftId: string | null = null;
            for (const [id, c] of hubClientMap.current) { if (c === conn) { leftId = id; break; } }
            if (!leftId) return;
            hubClientMap.current.delete(leftId);
            setPeers((p) => p.filter((id) => id !== leftId));
            hubBroadcast({ type: "leave", id: leftId });
          });
        });
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hp.on("error", (err: any) => {
      hubPeerRef.current = null; isHub.current = false; setIsHubState(false);
      if (err.type === "unavailable-id") joinHubAsClient(roomId, Peer);
      else setTimeout(() => tryBeHub(roomId, Peer), 3000 + Math.random() * 2000);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hubBroadcast(msg: object, excludeIds: string[] = []) {
    const raw = JSON.stringify(msg);
    for (const [id, c] of hubClientMap.current)
      if (!excludeIds.includes(id)) try { c.send(raw); } catch { /* ignore */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const joinHubAsClient = useCallback((roomId: string, Peer: any) => {
    const dp = new Peer(null, { config: { iceServers: ICE_SERVERS } });
    dp.on("open", () => {
      const conn = dp.connect(roomId, { reliable: true });
      conn.on("open", () => conn.send(JSON.stringify({ type: "hello", id: myIdRef.current })));
      conn.on("data", (raw: string) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "peers") setPeers(msg.list.filter((id: string) => id !== myIdRef.current));
          else if (msg.type === "join" && msg.id !== myIdRef.current) setPeers((p) => p.includes(msg.id) ? p : [...p, msg.id]);
          else if (msg.type === "leave") setPeers((p) => p.filter((id) => id !== msg.id));
        } catch { /* ignore */ }
      });
      conn.on("close", () => { dp.destroy(); setPeers([]); setTimeout(() => tryBeHub(roomId, Peer), Math.random() * 2000 + 500); });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dp.on("error", (err: any) => {
      dp.destroy();
      if (err.type === "peer-unavailable") setTimeout(() => tryBeHub(roomId, Peer), Math.random() * 1500 + 300);
      else setTimeout(() => joinHubAsClient(roomId, Peer), 3000);
    });
  }, [tryBeHub]);

  // ─── Initialization ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    if (SIGNAL_SERVER) {
      // ── WS mode: direct WebRTC, full LAN speed ──
      initWsMode(SIGNAL_SERVER);
      return () => { cancelled = true; wsRef.current?.close(); rtcPcRef.current?.close(); };
    }

    // ── PeerJS mode: works without any backend ──
    (async () => {
      const { default: Peer } = await import("peerjs");
      if (cancelled) return;

      const p = new Peer(myIdRef.current, { config: { iceServers: ICE_SERVERS } });
      peerRef.current = p;

      p.on("open", (id: string) => {
        myIdRef.current = id; setMyId(id); setStatus("online");
        if (!lanRoomId.current) getLanRoomId().then((roomId) => tryBeHub(roomId, Peer));
        const prevPeer = sessionStorage.getItem("ld_peer");
        if (prevPeer) {
          sessionStorage.removeItem("ld_peer");
          setTimeout(() => connectToPeer(prevPeer), 600);
        }
      });
      p.on("connection", (conn: unknown) => bindPeerConn(conn, (conn as { peer: string }).peer));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p.on("error", (err: any) => {
        const type: string = err?.type ?? "";
        if (type === "peer-unavailable") { addToast("Device not found.", "error"); resetConnection(); }
        else if (type === "unavailable-id") {
          myIdRef.current = genId(); setMyId(myIdRef.current);
          p.destroy(); peerRef.current = null;
          setTimeout(() => {
            if (cancelled) return;
            const p2 = new Peer(myIdRef.current, { config: { iceServers: ICE_SERVERS } });
            peerRef.current = p2;
            p2.on("open", (id: string) => { myIdRef.current = id; setMyId(id); setStatus("online"); });
            p2.on("connection", (conn: unknown) => bindPeerConn(conn, (conn as { peer: string }).peer));
          }, 200);
        } else if (type === "disconnected") {
          addToast("Lost server connection. Reconnecting…", "info");
        } else {
          addToast(`Connection error (${type || "unknown"}).`, "error");
          if (!dc.current) resetConnection();
        }
      });
    })();

    return () => { cancelled = true; peerRef.current?.destroy(); hubPeerRef.current?.destroy(); };
  }, [addToast, bindPeerConn, initWsMode, joinHubAsClient, resetConnection, tryBeHub]);

  // ─── Connect to peer ───────────────────────────────────────────────────────
  const connectToPeer = useCallback(async (targetId: string) => {
    const tid = targetId.trim().toUpperCase();
    if (tid.length < 2) { addToast("Enter a device ID.", "error"); return; }
    if (tid === myIdRef.current) { addToast("That's your own ID.", "error"); return; }
    setConnecting(true);
    connTimeout.current = setTimeout(() => {
      if (!connectedPeer) { addToast("Connection timed out.", "error"); resetConnection(); }
    }, 15000);

    if (SIGNAL_SERVER && wsRef.current?.readyState === WebSocket.OPEN) {
      // WS mode: create RTCPeerConnection and send offer via WebSocket
      const p = createWsPC(tid);
      const ch = p.createDataChannel("file-transfer", { ordered: true });
      ch.onopen = () => setupChannel(ch, tid);
      ch.onclose = () => { resetConnection(); addToast("Disconnected.", "info"); };
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      wsRef.current.send(JSON.stringify({ type: "offer", to: tid, sdp: offer }));
    } else if (peerRef.current) {
      // PeerJS mode
      const conn = peerRef.current.connect(tid, { reliable: true });
      bindPeerConn(conn, tid);
    } else {
      addToast("Not ready yet. Please wait.", "error");
      setConnecting(false);
    }
  }, [addToast, bindPeerConn, connectedPeer, createWsPC, resetConnection, setupChannel]);

  // ─── Accept / Decline file ─────────────────────────────────────────────────
  const acceptFile = useCallback(async () => {
    const meta = incomingFile!;
    setIncoming(null);
    try {
      if ("showSaveFilePicker" in window) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handle = await (window as any).showSaveFilePicker({ suggestedName: meta.name });
        receiveStream.current = await handle.createWritable();
      } else {
        receiveBuffer.current = [];
        if (meta.size > 500 * 1024 * 1024) addToast("Warning: >500 MB may crash non-Chrome browsers.", "error");
        else addToast("Buffering in RAM (no File System API).", "info");
      }
      receivedSize.current = 0; receiveStartTime.current = Date.now(); lastReceiveUI.current = 0;
      recvWindowBytes.current = 0; recvWindowStart.current = Date.now();
      showRecvProgress(0, meta.size, "Receiving • connecting...");
      dc.current?.send(JSON.stringify({ type: "accept" }));
    } catch { dc.current?.send(JSON.stringify({ type: "decline" })); }
  }, [addToast, incomingFile, showRecvProgress]);

  const declineFile = useCallback(() => {
    setIncoming(null);
    dc.current?.send(JSON.stringify({ type: "decline" }));
  }, []);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !dc.current) return;
    sendFileRef.current = file;
    addToast(`Awaiting permission to send ${file.name}…`, "info");
    dc.current.send(JSON.stringify({ type: "header", name: file.name, size: file.size, mime: file.type }));
    e.target.value = "";
  }, [addToast]);

  const peerPos = (i: number, total: number) => {
    const a = (i / total) * 2 * Math.PI - Math.PI / 2;
    return { left: 150 + Math.cos(a) * 115, top: 150 + Math.sin(a) * 115 };
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col antialiased" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <header className="w-full p-6 flex justify-between items-center z-10 relative">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-sky-400" viewBox="0 0 256 256" fill="currentColor">
            <path d="M231.4,44.34s0,.1,0,.15l-58.2,191.94a15.88,15.88,0,0,1-14,11.51q-.69.06-1.38.06a15.86,15.86,0,0,1-14.42-9.15L107,164.15a4,4,0,0,1,.77-4.58l57.92-57.92a8,8,0,0,0-11.31-11.31L96.43,148.26a4,4,0,0,1-4.58.77L17.08,112.64a16,16,0,0,1,2.49-29.8l191.94-58.2.15,0A16,16,0,0,1,231.4,44.34Z"/>
          </svg>
          <h1 className="text-2xl font-bold tracking-tight">Local<span className="text-sky-400">Drop</span></h1>
        </div>
        <div className="flex items-center gap-3 glass-panel px-4 py-2 rounded-full text-sm font-medium">
          <div className={`w-2.5 h-2.5 rounded-full ${status === "online" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-amber-400 animate-pulse"}`} />
          <span>
            {status === "online"
              ? SIGNAL_SERVER ? "Online (Direct)" : "Online (PeerJS)"
              : status === "error" ? "Disconnected" : "Connecting..."}
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4 z-10 relative w-full max-w-4xl mx-auto">
        {!connectedPeer ? (
          <div className="flex flex-col items-center w-full">
            {/* Radar */}
            <div className="radar-container mb-4">
              <div className="radar-circle" /><div className="radar-circle" /><div className="radar-circle" />
              <div className="absolute rounded-full border border-dashed border-slate-700/50 pointer-events-none"
                style={{ width: 230, height: 230, top: "50%", left: "50%", transform: "translate(-50%,-50%)" }} />
              {peers.slice(0, 8).map((id, i) => {
                const pos = peerPos(i, Math.min(peers.length, 8));
                return (
                  <button key={id} className="device-node" style={{ left: pos.left, top: pos.top }}
                    title={`Connect to ${id}`} onClick={() => { setTarget(id); connectToPeer(id); }}>
                    <div className="icon-ring">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="#38bdf8" viewBox="0 0 256 256">
                        <path d="M176,16H80A24,24,0,0,0,56,40V216a24,24,0,0,0,24,24h96a24,24,0,0,0,24-24V40A24,24,0,0,0,176,16ZM112,32h32a8,8,0,0,1,0,16H112a8,8,0,0,1,0-16Zm16,192a16,16,0,1,1,16-16A16,16,0,0,1,128,224Z"/>
                      </svg>
                      <span className="online-dot" />
                    </div>
                    <span className="node-label">{id}</span>
                  </button>
                );
              })}
              <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center z-10 shadow-xl border border-slate-600 relative">
                <Laptop size={30} color="#cbd5e1" />
                {status === "online" && <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-400 rounded-full border-2 border-slate-900" />}
              </div>
            </div>

            <p className="text-xs text-slate-500 mb-8 flex items-center gap-2 h-5">
              {peers.length === 0
                ? isHubState
                  ? <><span style={{ color: "#a78bfa", fontWeight: 600 }}>Hub active</span>&nbsp;— waiting for other devices</>
                  : <><SpinnerIcon /> Scanning for nearby devices…</>
                : isHubState
                  ? <><span style={{ color: "#a78bfa", fontWeight: 600 }}>Hub</span>&nbsp;— {peers.length} device{peers.length > 1 ? "s" : ""} connected</>
                  : <><span style={{ color: "#34d399", fontWeight: 600 }}>{peers.length} device{peers.length > 1 ? "s" : ""} nearby</span>&nbsp;— click to connect</>
              }
            </p>

            <div className="glass-panel p-8 rounded-3xl w-full max-w-md text-center">
              <p className="text-slate-400 text-sm mb-2 uppercase tracking-widest font-semibold">Your Device ID</p>
              <div className="text-4xl font-mono font-bold text-sky-400 mb-8 tracking-widest">{myId}</div>
              <div className="space-y-4">
                <p className="text-sm text-slate-300">Enter a peer&apos;s ID to connect directly:</p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input type="text" value={targetInput}
                    onChange={(e) => setTarget(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && connectToPeer(targetInput)}
                    placeholder="e.g. A1B2C" maxLength={5}
                    className="w-full sm:flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded-xl px-4 py-3 text-lg font-mono uppercase text-center focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-all placeholder:text-slate-600"
                  />
                  <button disabled={connecting} onClick={() => connectToPeer(targetInput)}
                    className="w-full sm:w-auto shrink-0 bg-sky-500 hover:bg-sky-400 text-slate-900 font-bold px-6 py-3 rounded-xl transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed sm:min-w-[130px]">
                    {connecting ? <><SpinnerIcon /><span>Connecting…</span></> : <span>Connect →</span>}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Transfer view */
          <div className="flex flex-col items-center w-full max-w-2xl">
            <div className="flex items-center justify-between w-full mb-8">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center border border-emerald-500/30">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z"/>
                  </svg>
                </div>
                <div>
                  <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold">Connected to</p>
                  <p className="text-xl font-bold text-white font-mono">{connectedPeer}</p>
                </div>
              </div>
              <button onClick={() => resetConnection(true)}
                className="text-slate-400 hover:text-red-400 transition-colors px-4 py-2 rounded-lg hover:bg-red-400/10 text-sm font-medium border border-transparent hover:border-red-400/20">
                Disconnect
              </button>
            </div>

            <div className="glass-panel w-full rounded-3xl p-8 border border-slate-700/50 relative overflow-hidden group">
              <div className="absolute inset-0 bg-sky-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              <div className="text-center">
                <CloudArrowUp className="w-16 h-16 text-sky-400 mb-4 mx-auto animate-bounce" weight="regular" />
                <h3 className="text-xl font-semibold mb-2">Send a File</h3>
                <p className="text-slate-400 text-sm mb-6">Unlimited size direct P2P transfer.</p>
                <label className="bg-slate-700 hover:bg-slate-600 border border-slate-500 text-white font-semibold py-3 px-8 rounded-xl transition-all shadow-lg active:scale-95 inline-flex items-center justify-center gap-2 cursor-pointer relative z-10">
                  <FolderOpen size={20} weight="fill" />
                  Select File
                  <input type="file" className="hidden" onChange={onFileSelect} />
                </label>
              </div>
              {(sendProgress || recvProgress) && (
                <div className="space-y-3 mt-8 relative z-10">
                  {sendProgress && (
                    <div className="w-full bg-slate-800 p-5 rounded-2xl border border-sky-800/60 shadow-inner">
                      <div className="flex justify-between text-sm mb-3 font-medium">
                        <span className="text-sky-400 flex items-center gap-2">
                          <SpinnerIcon />
                          <span>↑ {sendProgress.label}</span>
                        </span>
                        <span className="text-white font-mono">{sendProgress.pct}%</span>
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-3 overflow-hidden border border-slate-700">
                        <div className="bg-sky-500 h-full rounded-full transition-all duration-75 ease-linear" style={{ width: `${sendProgress.pct}%` }} />
                      </div>
                    </div>
                  )}
                  {recvProgress && (
                    <div className="w-full bg-slate-800 p-5 rounded-2xl border border-emerald-800/60 shadow-inner">
                      <div className="flex justify-between text-sm mb-3 font-medium">
                        <span className="text-emerald-400 flex items-center gap-2">
                          <SpinnerIcon />
                          <span>↓ {recvProgress.label}</span>
                        </span>
                        <span className="text-white font-mono">{recvProgress.pct}%</span>
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-3 overflow-hidden border border-slate-700">
                        <div className="bg-emerald-500 h-full rounded-full transition-all duration-75 ease-linear" style={{ width: `${recvProgress.pct}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="w-full mt-8 glass-panel rounded-2xl p-6">
              <h4 className="text-sm font-semibold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"/>
                </svg>
                Transfer History
              </h4>
              <div className="space-y-3 max-h-48 overflow-y-auto pr-2">
                {logs.length === 0
                  ? <div className="text-slate-500 text-sm italic text-center py-4">No files transferred yet.</div>
                  : logs.map((l) => (
                    <div key={l.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-800/50 border border-slate-700">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className={`w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0 ${l.direction === "Sent" ? "text-sky-400" : "text-emerald-400"}`}>
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                            <path d="M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Z"/>
                          </svg>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{l.name}</p>
                          <p className="text-xs text-slate-400">{l.direction} • {formatBytes(l.size)}</p>
                        </div>
                      </div>
                      {l.url
                        ? <a href={l.url} download={l.name} className="bg-emerald-500 hover:bg-emerald-400 text-slate-900 px-3 py-1 text-xs font-bold rounded-md transition-colors shadow-sm">Download</a>
                        : <span className="text-xs text-slate-500 font-bold bg-slate-800 px-2 py-1 rounded">Saved to Disk</span>
                      }
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Incoming file modal */}
      {incomingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4">
          <div className="glass-panel p-8 rounded-3xl w-full max-w-sm text-center border border-slate-600 shadow-2xl">
            <div className="w-20 h-20 bg-sky-500/20 text-sky-400 rounded-full flex items-center justify-center mx-auto mb-5 border border-sky-500/30">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 animate-bounce" fill="currentColor" viewBox="0 0 256 256">
                <path d="M224,152v56a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v56H208V152a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,132.69V40a8,8,0,0,0-16,0v92.69L93.66,106.34a8,8,0,0,0-11.32,11.32Z"/>
              </svg>
            </div>
            <h3 className="text-2xl font-bold mb-2 text-white">Incoming File</h3>
            <p className="text-slate-200 font-medium truncate mb-1 text-lg">{incomingFile.name}</p>
            <p className="text-sm text-slate-400 font-mono mb-8">{formatBytes(incomingFile.size)}</p>
            <div className="flex gap-4">
              <button onClick={declineFile} className="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-semibold py-3 rounded-xl transition-all border border-slate-600 active:scale-95">Decline</button>
              <button onClick={acceptFile} className="flex-1 bg-sky-500 hover:bg-sky-400 text-slate-900 font-bold py-3 rounded-xl transition-all shadow-lg shadow-sky-500/20 active:scale-95">Accept File</button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3">
        {toasts.map((t) => (
          <div key={t.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-xl text-sm font-medium ${
            t.type === "error" ? "bg-red-950 border-red-900 text-red-100" :
            t.type === "success" ? "bg-emerald-950 border-emerald-900 text-emerald-100" :
            "bg-slate-800 border-slate-700 text-white"
          }`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin w-4 h-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );
}
