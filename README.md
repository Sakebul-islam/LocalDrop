# LocalDrop

A browser-based peer-to-peer file transfer app that finds other devices on the same network and sends files directly over WebRTC.

## Features

- Each device gets a short random 5-character ID.
- Automatic discovery of other LocalDrop devices on the same network.
- Connect by clicking a found device, or by typing its ID.
- Files go device to device over a WebRTC data channel. They are not uploaded to a server.
- The receiver sees an "Incoming File" prompt and can accept or decline.
- Large files are sent in chunks with flow control, with live progress and transfer speed on both sides.
- On browsers with the File System Access API (for example Chrome), received files stream straight to disk. Other browsers buffer the file in memory and show a download button, with a warning above 500 MB.
- Transfer log of sent and received files.
- Reconnects to the last peer after a page reload (kept in `sessionStorage`).
- Toast messages for connection and transfer status.

## How it works

LocalDrop has two signaling modes:

1. **WebSocket mode** (when `NEXT_PUBLIC_SIGNAL_SERVER` is set). Devices register with a small WebSocket server that relays WebRTC offers, answers and ICE candidates and keeps the device list. `server.js` runs this next to the Next.js app at `/ws`. `signal-server.js` is a standalone version you can host separately.
2. **PeerJS mode** (default, no env var). The app uses the public PeerJS broker. Devices behind the same public IP derive the same room ID. The first device becomes a "hub" that shares the device list with the others.

Both modes use Google's public STUN server.

## Tech stack

- Next.js 14 (App Router, static export) and React 18
- TypeScript
- Tailwind CSS
- PeerJS and the browser WebRTC API
- `ws` for the WebSocket signaling server
- Phosphor Icons

## Getting started

Requirements: Node.js.

```bash
npm install
npm run dev     # runs server.js: Next.js + WebSocket signaling on port 3000
```

Open `http://<your-local-ip>:3000` on two devices on the same network.

Other scripts:

- `npm run build`: `next build` (static export to `out/`, used by `netlify.toml`)
- `npm start`: runs `server.js` with `NODE_ENV=production`

Environment variables (names only):

- `NEXT_PUBLIC_SIGNAL_SERVER`: WebSocket URL of a signaling server. If not set, PeerJS mode is used.
- `PORT`: port for `server.js` (default 3000) or `signal-server.js` (default 3001).

To run the standalone signaling server:

```bash
node signal-server.js
```

There is also a single-file version in `index.html` at the repo root. It loads Tailwind, PeerJS and Phosphor Icons from CDNs and can be opened on its own.

## Project structure

```
LocalDrop/
├── src/app/
│   ├── page.tsx        # the whole app UI and transfer logic
│   ├── layout.tsx
│   └── globals.css
├── server.js           # custom Next.js server with WebSocket signaling at /ws
├── signal-server.js    # standalone WebSocket signaling server
├── index.html          # single-file CDN version
├── next.config.mjs     # output: "export"
├── netlify.toml
└── tailwind.config.js
```

## Author

Built by [Sakebul Islam](https://sakebul.com) · [LinkedIn](https://www.linkedin.com/in/sakebul-islam)
