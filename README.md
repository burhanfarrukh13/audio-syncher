# Sync Audio

Play the same audio file on your laptop and phone at (nearly) the same instant — over your home WiFi, no internet or app install required.

<!-- Add a demo GIF or screenshot here. This sells the project way more than the text does. -->
<!-- ![demo](public/demo.gif) -->

## Table of Contents

- [How it works](#how-it-works)
- [Setup (one-time)](#setup-one-time)
- [Run it](#run-it)
- [Limitations](#limitations)
- [Deploying over the internet](#deploying-over-the-internet)

## How it works

- Your laptop runs a small local server.
- Laptop and phone both open a webpage from that server (same WiFi network, no internet needed).
- Each device measures how far off its clock is from the server's clock.
- The host hits **Play** → the server tells every device "start at this exact moment" → each device starts playback using precise browser audio scheduling instead of a plain timer.

Expect accuracy in the tens of milliseconds — synced to the ear, not sample-perfect studio-grade sync.

## Setup (one-time)

1. Install [Node.js](https://nodejs.org) (v18+ recommended).
2. Install [Git](https://git-scm.com).
3. Open PowerShell **as admin** and run:
   ```
   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```
4. Open a port on your firewall so your phone can reach the server:
   - Press `Win + R`, type `wf.msc`, hit Enter (opens Windows Defender Firewall with Advanced Security).
   - Click **Inbound Rules** (left panel) → **New Rule** (right panel).
   - Select **Port** → Next.
   - **TCP**, Specific local ports: `3000` → Next.
   - **Allow the connection** → Next.
   - Check all three profiles (Domain, Private, Public) → Next.
   - Name it `Sync Audio` → Finish.
5. Clone this repo, then open a terminal in that folder.
6. Install dependencies:
   ```
   npm install
   ```

## Run it

1. Start the server:
   ```
   npm start
   ```
2. The terminal will print something like:
   ```
   On this laptop, open:  http://localhost:3000
   On your phone (same WiFi), open one of these:
     http://192.168.x.x:3000
   ```
3. **On your laptop:** open `http://localhost:3000` → click **Host a room**. You'll get a 4-digit room code.
4. **On your phone:** connect to the **same WiFi** as your laptop → open the `http://192.168.x.x:3000` address from the terminal → enter the room code → tap **Join**.
5. **Back on the laptop (host):** choose an MP3 (or any audio file) → hit **Play in sync**. Both devices start together.

## Limitations

- Both devices must be on the same WiFi network — this doesn't work over mobile data or across different networks. It's a local-network tool, not a hosted service.
- Audio plays through each device's **own** speaker. This does not route your laptop's audio output to your phone's speaker (that's OS-level audio routing — a different, much harder problem).
- If your laptop sleeps or the browser tab closes, the server/room dies.
- Large files (100MB+) transfer slowly over the socket — stick to normal song-length MP3s for now.
- Pause is instant on all devices but not precisely synced (fine for pausing — it matters far less than play sync).

## Deploying over the internet

To make this work beyond a shared WiFi network, deploy `server.js` to a host that supports persistent WebSocket connections — **Render, Railway, or Fly.io**. Plain Netlify/Vercel static hosting won't work since it doesn't keep a socket connection open.

This is a small config change, not a rewrite of the app.

## Tech Stack

- Node.js + Express
- Socket.io (WebSocket sync)
- Vanilla JS, HTML, CSS on the client

## License

No license set yet — add one (MIT is the standard default for portfolio projects) if you want others to be able to use or contribute to this.
