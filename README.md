```markdown
# Sync Audio

Play audio — with real seek, a queue, room chat, and a live visualizer — on your laptop and phone at (nearly) the same instant, over your home WiFi. No internet or app install required.

<!-- Add a demo GIF or screenshot here. This sells the project way more than the text does. -->

<!-- ![demo](public/demo.gif) -->

## Table of Contents

* [Features](#features)
* [How it works](#how-it-works)
* [Setup (one-time)](#setup-one-time)
* [Run it](#run-it)
* [Limitations](#limitations)
* [Deploying over the internet](#deploying-over-the-internet)

## Features

* **Real sync, not a hack** — audio is decoded in-browser and played back on a scheduled clock so every device starts (and seeks) at the same instant. Nothing is just "played locally and hoped for the best."
* **Track queue** — the host can queue multiple tracks, mixing local files and YouTube links, and step through them (`room.queue[]` / `room.currentIndex` server-side).
* **YouTube support** — YouTube links are resolved server-side via `yt-dlp` into audio, then played back through the same sample-accurate scheduling path as local files (no separate/laggy streaming mechanism, no echo).
* **Seek** — the host can jump ±10 seconds or drag the progress bar, and every connected device jumps to the same point together.
* **Room chat** — text chat between host and listeners in the same room.
* **Live visualizer** — a circular frequency visualizer driven by the actual playing audio (Web Audio `AnalyserNode`), not a canned animation.
* **Local caching (IndexedDB)** — once a device has downloaded a track, it's cached in the browser. Refreshing the page or rejoining the same room skips re-downloading the file.
* **Late-join catch-up** — a device that joins mid-song starts from the correct position instead of silence until the next play/pause.
* **Reconnect / rejoin persistence** — devices that drop (e.g. iOS Safari discarding a backgrounded tab) can rejoin the same room and resume via `sessionStorage`.
* **Host-visible readiness tracking** — a progress bar shows the host which devices have finished loading a track (`track-ready` events) before playback starts.
* **Host-only playback control** — only the host's device can play/pause/seek/change tracks; the server enforces this, it isn't just hidden in the UI.

## How it works

* Your laptop runs a small local server (Node + Express + Socket.io).
* Laptop and phone both open a webpage from that server — same WiFi network, no internet needed.
* For local files: the host uploads an audio file, sent once in full to every connected device over the socket connection, then decoded client-side into an in-memory `AudioBuffer`.
* For YouTube tracks: the server resolves the link with `yt-dlp`, downloads the audio, and sends it to devices the same way as a local file — so it goes through identical scheduling, with no separate streaming path and no echo.
* Because every device holds the *entire decoded track*, not a stream, seeking is just "start a new buffer source at a different offset" — no re-buffering.
* The host hits **Play**, **Pause**, seeks, or advances the queue → the server relays the command to every device with a target position → each device schedules playback ~1 second in the future using precise Web Audio scheduling instead of a plain JS timer, so they all land on "now" at the same instant.

Expect accuracy in the tens of milliseconds on a normal home WiFi network — synced to the ear, not sample-perfect studio-grade sync.

## Setup (one-time)

1. Install [Node.js](https://nodejs.org) (v18+ recommended).
2. Install [Git](https://git-scm.com).
3. Open PowerShell **as admin** and run:
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser

```

4. Open a port on your firewall so your phone can reach the server:

* Press `Win + R`, type `wf.msc`, hit Enter (opens Windows Defender Firewall with Advanced Security).
* Click **Inbound Rules** (left panel) → **New Rule** (right panel).
* Select **Port** → Next.
* **TCP**, Specific local ports: `3000` → Next.
* **Allow the connection** → Next.
* Check all three profiles (Domain, Private, Public) → Next.
* Name it `Sync Audio` → Finish.

5. Install `yt-dlp` (needed for YouTube audio tracks):

```bash
pip install yt-dlp

```

If Windows can't find `yt-dlp` on the PATH afterward, add its install location manually (adjust the Python version folder to match yours — check with `python -m site --user-base`):

```powershell
$env:PATH += ";C:\Users\user\AppData\Local\Python\pythoncore-3.14-64\Scripts"

```

That only persists for the current PowerShell session. To make it permanent:

```powershell
[Environment]::SetEnvironmentVariable("Path", $env:PATH + ";C:\Users\user\AppData\Local\Python\pythoncore-3.14-64\Scripts", "User")

```

6. Clone this repo, then open a terminal in that folder.
7. Install dependencies:

```bash
npm install

```

## Run it

1. Start the server:

```bash
npm start

```

2. The terminal will print something like:

```text
On this laptop, open:  http://localhost:3000
On your phone (same WiFi), open one of these:
[http://192.168.](http://192.168.)x.x:3000

```

3. **On your laptop:** open `http://localhost:3000` → click **Host a room**. You'll get a 4-digit room code.
4. **On your phone:** connect to the **same WiFi** as your laptop → open the `http://192.168.x.x:3000` address from the terminal → enter the room code → tap **Join**.
5. **Back on the laptop (host):** add a local file or YouTube link to the queue → hit **Play**. Both devices start together. Use the ±10s buttons or drag the progress bar to seek — everyone jumps together.
6. Use the chat box on either device to send messages to the room.

## Limitations

* Both devices must be on the same WiFi network — this doesn't work over mobile data or across different networks by default (see [Deploying over the internet](https://www.google.com/search?q=%23deploying-over-the-internet)).
* Audio plays through each device's **own** speaker. This does not route your laptop's audio output to your phone's speaker (that's OS-level audio routing — a different, much harder problem).
* If your laptop sleeps or the browser tab closes, the server/room dies.
* Large local files (40-50MB+) transfer more slowly over the socket — stick to normal song-length tracks.
* **iOS Safari will suspend the AudioContext when the phone locks or the tab backgrounds.** This is an OS-level restriction, not a bug in this app. Reconnect/rejoin logic mitigates this, but a listener may still need to bring the tab back to the foreground.
* Sync uses a fixed scheduling delay, not true clock-drift correction (NTP-style). Fine on a normal home LAN; don't expect it to hold up over a slow or congested network.
* YouTube tracks require `yt-dlp` on the host machine and add a download step before playback can start — no true live-streaming.

## Deploying over the internet

To make this work beyond a shared WiFi network, deploy `server.js` to a host that supports persistent WebSocket connections — **Render, Railway, or Fly.io**. Plain Netlify/Vercel static hosting won't work since it doesn't keep a socket connection open. A `render.yaml` is already included in this repo for a one-click Render deploy.

This is a small config change, not a rewrite of the app.

## Tech Stack

* Node.js + Express
* Socket.io (WebSocket sync)
* Vanilla JS, HTML, CSS on the client
* Web Audio API (`AudioBufferSourceNode` for scheduled playback, `AnalyserNode` for the visualizer)
* IndexedDB (client-side track caching)
* `yt-dlp` (server-side YouTube audio resolution)

## License

No license set yet — add one (MIT is the standard default for portfolio projects) if you want others to be able to use or contribute to this.

```

```