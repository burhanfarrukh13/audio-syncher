# Sync Audio

Play the same audio file on your laptop and phone at (nearly) the same instant.

## How it works
- Your laptop runs a small local server.
- Laptop and phone both open a webpage from that server (over your home WiFi — no internet needed).
- Each device figures out how far off its clock is from the server's clock.
- Host picks Play → tells every device "start at this exact moment" → each device
  starts using precise browser audio scheduling, not a plain timer.

Expect accuracy in the tens of milliseconds — good enough that it sounds synced
to the ear, not sample-perfect studio-grade sync.

## Setup (one-time)
1. Install [Node.js](https://nodejs.org) if you don't have it (v18+ recommended).
2. Open a terminal in this folder.
3. Run:
   ```
   npm install
   ```

## Run it
1. Start the server:
   ```
   npm start
   ```
2. Terminal will print something like:
   ```
   On this laptop, open:  http://localhost:3000
   On your phone (same WiFi), open one of these:
     http://192.168.x.x:3000
   ```
3. **On your laptop browser:** open `http://localhost:3000`, click **Host a room**.
   You'll get a 4-digit code.
4. **On your phone:** make sure it's on the SAME WiFi network as your laptop.
   Open the `http://192.168.x.x:3000` address from the terminal, enter the room
   code, tap **Join**.
5. Back on the laptop (host), choose an MP3 (or any audio file), then hit
   **Play in sync**. Both devices should start together.

## Notes / limitations (read before you're confused)
- Both devices must be on the same WiFi network. This does not work over
  mobile data or different networks — it's a local-network tool, not a
  hosted service.
- Audio only comes through each device's OWN speaker. This does not route
  your laptop's audio output to the phone's speaker — that's a different,
  much harder problem (OS-level audio routing) and not what this solves.
- If your laptop goes to sleep or you close the browser tab, the server/room dies.
- Large files (100MB+) will be slow to transfer over the socket — keep it to
  normal song-length MP3s for now.
- Pause is instant on all devices but not precisely synced (fine for a pause,
  matters much less than play).

## If you want this working over the internet (not just same WiFi)
Deploy `server.js` to a free host that supports persistent WebSocket
connections (Render, Railway, Fly.io — NOT plain Netlify/Vercel static
hosting, which doesn't keep a socket connection open). Ask me and I'll walk
you through it — it's a small change, not a rewrite.
