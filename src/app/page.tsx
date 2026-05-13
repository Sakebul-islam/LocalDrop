"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const CHUNK_SIZE   = 64  * 1024;        // 64 KB — safe SCTP message size
const SEGMENT_SIZE = 16  * 1024 * 1024; // 16 MB read per await
const HIGHWATER    = 4   * 1024 * 1024; // pause when buffer > 4 MB
const LOWWATER     = 256 * 1024;        // resume when buffer < 256 KB

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let r = "";
  for (let i = 0; i < 5; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function formatBytes(b: number) {
  if (!b) return "0 B";
  const k = 1024, i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(2)} ${["B","KB","MB","GB","TB"][i]}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Toast { id: number; msg: string; type: "info" | "success" | "error"; }
interface LogEntry { id: number; direction: "Sent" | "Received"; name: string; size: number; url?: string; }
interface FileMeta { name: string; size: number; mime: string; }

// ─── Component ────────────────────────────────────────────────────────────────
export default function Page() {
  const myId = useRef(genId());

  // Connection state
  const ws         = useRef<WebSocket | null>(null);
  const pc         = useRef<RTCPeerConnection | null>(null);
  const dc         = useRef<RTCDataChannel | null>(null);
  const connTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Transfer state (refs to avoid stale closures in async loops)
  const sendFileRef      = useRef<File | null>(null);
  const receiveMeta      = useRef<FileMeta | null>(null);
  const receiveStream    = useRef<FileSystemWritableFileStream | null>(null);
  const receiveBuffer    = useRef<ArrayBuffer[]>([]);
  const receivedSize     = useRef(0);
  const receiveStartTime = useRef(0);
  const lastReceiveUI    = useRef(0);

  // UI state
  const [status, setStatus]           = useState<"connecting" | "online" | "error">("connecting");
  const [connectedPeer, setConnected] = useState<string | null>(null);
  const [peers, setPeers]             = useState<string[]>([]);
  const [toasts, setToasts]           = useState<Toast[]>([]);
  const [logs, setLogs]               = useState<LogEntry[]>([]);
  const [targetInput, setTarget]      = useState("");
  const [connecting, setConnecting]   = useState(false);
  const [incomingFile, setIncoming]   = useState<FileMeta | null>(null);
  const [progress, setProgress]       = useState<{ pct: number; label: string } | null>(null);

  const toastId = useRef(0);
  const logId   = useRef(0);

  const addToast = useCallback((msg: string, type: Toast["type"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const addLog = useCallback((direction: LogEntry["direction"], name: string, size: number, url?: string) => {
    const id = ++logId.current;
    setLogs((l) => [{ id, direction, name, size, url }, ...l]);
  }, []);

  // ─── Progress helpers ──────────────────────────────────────────────────────
  const showProgress = useCallback((current: number, total: number, label: string) => {
    setProgress({ pct: Math.min(100, Math.round((current / total) * 100)), label });
  }, []);

  const hideProgress = useCallback(() => setProgress(null), []);

  // ─── Close / reset connection ──────────────────────────────────────────────
  const resetConnection = useCallback(() => {
    dc.current?.close();
    pc.current?.close();
    dc.current = null;
    pc.current = null;
    if (connTimeout.current) clearTimeout(connTimeout.current);
    setConnected(null);
    setConnecting(false);
    hideProgress();
  }, [hideProgress]);

  // ─── Data channel message handler ─────────────────────────────────────────
  const handleData = useCallback(async (data: MessageEvent["data"]) => {
    if (typeof data === "string") {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === "header") {
        const meta = msg as unknown as FileMeta & { type: string };
        receiveMeta.current = { name: meta.name, size: meta.size, mime: meta.mime };
        setIncoming({ name: meta.name, size: meta.size, mime: meta.mime });
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
          const url  = URL.createObjectURL(blob);
          addLog("Received", meta.name, meta.size, url);
          addToast(`${meta.name} ready — click Download!`, "success");
        }
        showProgress(meta.size, meta.size, "Received ✓");
        setTimeout(hideProgress, 1200);
        receiveMeta.current    = null;
        receiveBuffer.current  = [];
        receiveStream.current  = null;
        receivedSize.current   = 0;
      }
    } else {
      // Binary chunk
      const buf: ArrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
      receivedSize.current += buf.byteLength;

      const now = Date.now();
      if (now - lastReceiveUI.current >= 80) {
        lastReceiveUI.current = now;
        const elapsed = (now - receiveStartTime.current) / 1000 || 0.001;
        showProgress(
          receivedSize.current,
          receiveMeta.current!.size,
          `Receiving • ${formatBytes(receivedSize.current / elapsed)}/s`
        );
      }

      if (receiveStream.current) await receiveStream.current.write(buf);
      else receiveBuffer.current.push(buf);
    }
  }, [addLog, addToast, hideProgress, showProgress]);

  // ─── High-throughput sender ────────────────────────────────────────────────
  async function startSendingChunks() {
    const file    = sendFileRef.current;
    const channel = dc.current;
    if (!file || !channel) return;

    let offset    = 0;
    const startTime = Date.now();
    channel.bufferedAmountLowThreshold = LOWWATER;
    showProgress(0, file.size, "Sending • starting…");
    let lastUI = Date.now();

    try {
      while (offset < file.size) {
        const segEnd  = Math.min(offset + SEGMENT_SIZE, file.size);
        const segment = await file.slice(offset, segEnd).arrayBuffer();
        const view    = new Uint8Array(segment);
        let   segPos  = 0;

        while (segPos < view.byteLength) {
          if (channel.bufferedAmount >= HIGHWATER) {
            await new Promise<void>((resolve) => {
              channel.onbufferedamountlow = () => {
                channel.onbufferedamountlow = null;
                resolve();
              };
            });
          }
          const end = Math.min(segPos + CHUNK_SIZE, view.byteLength);
          channel.send(view.subarray(segPos, end));
          offset  += end - segPos;
          segPos   = end;

          const now = Date.now();
          if (now - lastUI >= 80) {
            lastUI = now;
            const elapsed = (now - startTime) / 1000 || 0.001;
            showProgress(offset, file.size, `Sending • ${formatBytes(offset / elapsed)}/s`);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`Send error: ${msg}`, "error");
      hideProgress();
      sendFileRef.current = null;
      return;
    }

    showProgress(file.size, file.size, "Sent ✓");
    channel.send(JSON.stringify({ type: "end" }));
    addToast("Transfer complete!", "success");
    addLog("Sent", file.name, file.size);
    setTimeout(hideProgress, 1200);
    sendFileRef.current = null;
  }

  // ─── WebRTC setup ──────────────────────────────────────────────────────────
  const setupDataChannel = useCallback((channel: RTCDataChannel, peerId: string) => {
    dc.current = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (connTimeout.current) clearTimeout(connTimeout.current);
      addToast("Connected!", "success");
      setConnected(peerId);
      setConnecting(false);
    };
    channel.onmessage = (e) => handleData(e.data);
    channel.onclose   = () => { resetConnection(); addToast("Disconnected.", "info"); };
    channel.onerror   = () => { resetConnection(); addToast("Connection error.", "error"); };
  }, [addToast, handleData, resetConnection]);

  const createPeerConnection = useCallback(() => {
    const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.current = p;
    p.onicecandidate = (e) => {
      if (e.candidate && ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({
          type: "ice",
          to: connectedPeer || targetInput.toUpperCase(),
          candidate: e.candidate.toJSON(),
        }));
      }
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === "failed") {
        addToast("Connection failed.", "error");
        resetConnection();
      }
    };
    return p;
  }, [addToast, connectedPeer, resetConnection, targetInput]);

  // ─── WebSocket connect & signaling ────────────────────────────────────────
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.current = socket;
    // Track the remote peer we're establishing a connection with
    let pendingPeerId = "";

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "register", id: myId.current }));
    };

    socket.onmessage = async (e) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case "registered":
          setStatus("online");
          break;

        case "peers":
          setPeers((msg.list as string[]).filter((id) => id !== myId.current));
          break;

        case "peer-joined":
          if (msg.id !== myId.current)
            setPeers((p) => p.includes(msg.id as string) ? p : [...p, msg.id as string]);
          break;

        case "peer-left":
          setPeers((p) => p.filter((id) => id !== msg.id));
          break;

        case "offer": {
          // Inbound call — create PC as answerer
          pendingPeerId = msg.from as string;
          const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          pc.current = p;
          p.onicecandidate = (ev) => {
            if (ev.candidate && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: "ice", to: pendingPeerId, candidate: ev.candidate.toJSON() }));
          };
          p.ondatachannel = (ev) => setupDataChannel(ev.channel, pendingPeerId);
          p.onconnectionstatechange = () => {
            if (p.connectionState === "failed") { addToast("Connection failed.", "error"); resetConnection(); }
          };
          await p.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
          const answer = await p.createAnswer();
          await p.setLocalDescription(answer);
          socket.send(JSON.stringify({ type: "answer", to: pendingPeerId, sdp: answer }));
          break;
        }

        case "answer":
          if (pc.current) {
            await pc.current.setRemoteDescription(
              new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit)
            );
          }
          break;

        case "ice":
          if (pc.current) {
            try {
              await pc.current.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
            } catch (_) {}
          }
          break;
      }
    };

    socket.onerror = () => setStatus("error");
    socket.onclose = () => {
      setStatus("error");
      // Reconnect after 3 s
      setTimeout(() => {
        const s2 = new WebSocket(`${proto}://${window.location.host}/ws`);
        ws.current = s2;
        s2.onopen = () => {
          s2.send(JSON.stringify({ type: "register", id: myId.current }));
          setStatus("online");
        };
        s2.onmessage = socket.onmessage;
        s2.onerror   = socket.onerror;
        s2.onclose   = socket.onclose;
      }, 3000);
    };

    return () => socket.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Initiate outgoing connection ─────────────────────────────────────────
  const connectToPeer = useCallback(async (targetId: string) => {
    if (!targetId || targetId.length < 2) { addToast("Enter a device ID.", "error"); return; }
    if (targetId === myId.current) { addToast("That's your own ID.", "error"); return; }
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      addToast("Not connected to server yet. Please wait.", "error"); return;
    }
    setConnecting(true);
    connTimeout.current = setTimeout(() => {
      if (!connectedPeer) { addToast("Connection timed out.", "error"); resetConnection(); }
    }, 15000);

    const p = createPeerConnection();
    const channel = p.createDataChannel("file-transfer", { ordered: true });
    setupDataChannel(channel, targetId);

    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    ws.current?.send(JSON.stringify({ type: "offer", to: targetId, sdp: offer }));
  }, [addToast, connectedPeer, createPeerConnection, resetConnection, setupDataChannel]);

  // ─── Accept / decline incoming file ───────────────────────────────────────
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
        if (meta.size > 500 * 1024 * 1024)
          addToast("Warning: >500 MB may crash non-Chrome browsers.", "error");
        else
          addToast("Buffering in RAM (no File System API).", "info");
      }
      receivedSize.current   = 0;
      receiveStartTime.current = Date.now();
      lastReceiveUI.current  = 0;
      showProgress(0, meta.size, "Receiving • connecting...");
      dc.current?.send(JSON.stringify({ type: "accept" }));
    } catch {
      dc.current?.send(JSON.stringify({ type: "decline" }));
    }
  }, [addToast, incomingFile, showProgress]);

  const declineFile = useCallback(() => {
    setIncoming(null);
    dc.current?.send(JSON.stringify({ type: "decline" }));
  }, []);

  // ─── File select handler ───────────────────────────────────────────────────
  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !dc.current) return;
    sendFileRef.current = file;
    addToast(`Awaiting permission to send ${file.name}…`, "info");
    dc.current.send(JSON.stringify({ type: "header", name: file.name, size: file.size, mime: file.type }));
    e.target.value = "";
  }, [addToast]);

  // ─── Radar helpers ────────────────────────────────────────────────────────
  function peerPosition(i: number, total: number) {
    const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
    const orbit = 115;
    const cx = 150, cy = 150;
    return { left: cx + Math.cos(angle) * orbit, top: cy + Math.sin(angle) * orbit };
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col antialiased" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <header className="w-full p-6 flex justify-between items-center z-10 relative">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-sky-400" viewBox="0 0 256 256" fill="currentColor">
            <path d="M227.31,28.69a16,16,0,0,0-22.62,0L187.31,46.06,165.19,23.94a8,8,0,0,0-11.32,11.32l7,7L128,75.1,95.13,42.26l7-7A8,8,0,0,0,90.81,23.94L68.69,46.06,51.31,28.69A16,16,0,0,0,28.69,51.31L46.06,68.69,23.94,90.81a8,8,0,0,0,11.32,11.32l7-7L75.1,128,42.26,160.87l-7-7A8,8,0,0,0,23.94,165.19l22.12,22.12L28.69,204.69a16,16,0,0,0,22.62,22.62L68.69,209.94l22.12,22.12a8,8,0,0,0,11.32-11.32l-7-7L128,180.9l32.87,32.87-7,7a8,8,0,0,0,11.32,11.32l22.12-22.12,17.38,17.38a16,16,0,0,0,22.62-22.62L209.94,187.31l22.12-22.12a8,8,0,0,0-11.32-11.32l-7,7L180.9,128l32.87-32.87,7,7a8,8,0,0,0,11.32-11.32L209.94,68.69l17.37-17.38A16,16,0,0,0,227.31,28.69ZM128,163.31,92.69,128,128,92.69,163.31,128Z"/>
          </svg>
          <h1 className="text-2xl font-bold tracking-tight">Local<span className="text-sky-400">Drop</span></h1>
        </div>
        <div className="flex items-center gap-3 glass-panel px-4 py-2 rounded-full text-sm font-medium">
          <div className={`w-2.5 h-2.5 rounded-full ${
            status === "online" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-amber-400 animate-pulse"
          }`} />
          <span>{status === "online" ? "Online" : status === "error" ? "Disconnected" : "Connecting..."}</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4 z-10 relative w-full max-w-4xl mx-auto">
        {!connectedPeer ? (
          /* ── Discovery view ── */
          <div className="flex flex-col items-center w-full">
            <div className="radar-container mb-4">
              <div className="radar-circle" />
              <div className="radar-circle" />
              <div className="radar-circle" />
              {/* Orbit ring */}
              <div className="absolute rounded-full border border-dashed border-slate-700/50 pointer-events-none"
                style={{ width: 230, height: 230, top: "50%", left: "50%", transform: "translate(-50%,-50%)" }} />
              {/* Peer nodes */}
              {peers.slice(0, 8).map((id, i) => {
                const pos = peerPosition(i, Math.min(peers.length, 8));
                return (
                  <button key={id} className="device-node" style={{ left: pos.left, top: pos.top }}
                    title={`Connect to ${id}`}
                    onClick={() => { setTarget(id); connectToPeer(id); }}>
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
              {/* Self */}
              <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center z-10 shadow-xl border border-slate-600 relative">
                <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="#cbd5e1" viewBox="0 0 256 256">
                  <path d="M232,168H208V112a24,24,0,0,0-24-24H152V56a24,24,0,0,0-24-24H72A24,24,0,0,0,48,56V168H24a8,8,0,0,0,0,16H64v8a24,24,0,0,0,24,24h80a24,24,0,0,0,24-24v-8h40a8,8,0,0,0,0-16Z"/>
                </svg>
                {status === "online" && (
                  <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-400 rounded-full border-2 border-slate-900" />
                )}
              </div>
            </div>

            <p className="text-xs text-slate-500 mb-8 flex items-center gap-2 h-5">
              {peers.length === 0
                ? <><SpinnerIcon />Scanning for nearby devices…</>
                : <><span className="text-emerald-400 font-semibold">{peers.length} device{peers.length > 1 ? "s" : ""} nearby</span> — click to connect</>
              }
            </p>

            <div className="glass-panel p-8 rounded-3xl w-full max-w-md text-center">
              <p className="text-slate-400 text-sm mb-2 uppercase tracking-widest font-semibold">Your Device ID</p>
              <div className="text-4xl font-mono font-bold text-sky-400 mb-8 tracking-widest">{myId.current}</div>
              <div className="space-y-4">
                <p className="text-sm text-slate-300">Enter a peer&apos;s ID to connect directly:</p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="text"
                    value={targetInput}
                    onChange={(e) => setTarget(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && connectToPeer(targetInput)}
                    placeholder="e.g. A1B2C"
                    maxLength={5}
                    className="w-full sm:flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded-xl px-4 py-3 text-lg font-mono uppercase text-center focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-all placeholder:text-slate-600"
                  />
                  <button
                    disabled={connecting}
                    onClick={() => connectToPeer(targetInput)}
                    className="w-full sm:w-auto shrink-0 bg-sky-500 hover:bg-sky-400 text-slate-900 font-bold px-6 py-3 rounded-xl transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed sm:min-w-[130px]"
                  >
                    {connecting ? <><SpinnerIcon /><span>Connecting…</span></> : <span>Connect →</span>}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Transfer view ── */
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
              <button onClick={resetConnection}
                className="text-slate-400 hover:text-red-400 transition-colors px-4 py-2 rounded-lg hover:bg-red-400/10 text-sm font-medium border border-transparent hover:border-red-400/20">
                Disconnect
              </button>
            </div>

            <div className="glass-panel w-full rounded-3xl p-8 border border-slate-700/50 relative overflow-hidden group">
              <div className="absolute inset-0 bg-sky-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              <div className="text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-16 h-16 text-sky-400 mb-4 mx-auto animate-bounce" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M248,128a87.34,87.34,0,0,1-17.6,52.81,8,8,0,1,1-12.8-9.62A71.34,71.34,0,0,0,232,128a72,72,0,0,0-144,0,8,8,0,0,1-16,0,88,88,0,0,1,176,0Zm-90.67,41.76-20,24a8,8,0,0,1-12.66,0l-20-24A8,8,0,0,1,117.33,160H120v-32a8,8,0,0,1,16,0v32h2.67A8,8,0,0,1,157.33,169.76Z"/>
                </svg>
                <h3 className="text-xl font-semibold mb-2">Send a File</h3>
                <p className="text-slate-400 text-sm mb-6">Unlimited size direct P2P transfer.</p>
                <label className="bg-slate-700 hover:bg-slate-600 border border-slate-500 text-white font-semibold py-3 px-8 rounded-xl transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2 mx-auto cursor-pointer w-fit relative z-10">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M245,110.64A16,16,0,0,0,232,104H216V88a24,24,0,0,0-24-24H130.67L102.94,41.6a16.05,16.05,0,0,0-9.6-3.2H48A24,24,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16,16,0,0,0,245,110.64Z"/>
                  </svg>
                  Select File
                  <input type="file" className="hidden" onChange={onFileSelect} />
                </label>
              </div>

              {/* Progress bar */}
              {progress && (
                <div className="w-full mt-8 bg-slate-800 p-5 rounded-2xl border border-slate-600 shadow-inner relative z-10">
                  <div className="flex justify-between text-sm mb-3 font-medium">
                    <span className="text-sky-400 flex items-center gap-2">
                      <SpinnerIcon />{progress.label}
                    </span>
                    <span className="text-white font-mono">{progress.pct}%</span>
                  </div>
                  <div className="w-full bg-slate-900 rounded-full h-3 overflow-hidden border border-slate-700">
                    <div className="bg-sky-500 h-full rounded-full transition-all duration-75 ease-linear"
                      style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
              )}
            </div>

            {/* Transfer history */}
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
                          {l.direction === "Sent"
                            ? <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32ZM152,88a8,8,0,0,1-16,0V56a8,8,0,0,1,16,0Z"/></svg>
                            : <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32ZM152,88a8,8,0,0,1-16,0V56a8,8,0,0,1,16,0Z"/></svg>
                          }
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
              <button onClick={declineFile}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-semibold py-3 rounded-xl transition-all border border-slate-600 active:scale-95">
                Decline
              </button>
              <button onClick={acceptFile}
                className="flex-1 bg-sky-500 hover:bg-sky-400 text-slate-900 font-bold py-3 rounded-xl transition-all shadow-lg shadow-sky-500/20 active:scale-95">
                Accept File
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast container */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3">
        {toasts.map((t) => (
          <div key={t.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-xl text-sm font-medium transition-all duration-300 ${
              t.type === "error" ? "bg-red-950 border-red-900 text-red-100" :
              t.type === "success" ? "bg-emerald-950 border-emerald-900 text-emerald-100" :
              "bg-slate-800 border-slate-700 text-white"
            }`}>
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );
}
