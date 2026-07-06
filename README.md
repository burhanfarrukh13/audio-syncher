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

## Deploy it publicly (for two people on different networks / mobile data)

The WiFi-only version above only works if both devices share one router. For
two people on separate networks (e.g. 50km apart, one or both on mobile
data), the server has to live on the internet, not your laptop. Do this once:

### Step 1 — Get the code onto GitHub (skip if you already have a repo)
1. Go to github.com, sign in (or create a free account).
2. Click the **+** top-right → **New repository**. Name it `sync-audio`,
   leave it Public, click **Create repository**.
3. On the new repo page, click **uploading an existing file**.
4. Drag in every file from this folder (server.js, package.json,
   render.yaml, README.md, and the `public` folder with its 3 files) —
   do NOT upload `node_modules` if it exists, it's not needed.
5. Scroll down, click **Commit changes**.

### Step 2 — Deploy on Render
1. Go to render.com, sign up (free — "Sign up with GitHub" is fastest).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account if asked, select the `sync-audio` repo.
4. Render should auto-detect the settings from `render.yaml`
   (build: `npm install`, start: `npm start`). If it doesn't auto-fill,
   enter those two manually.
5. Plan: **Free**. Click **Create Web Service**.
6. Wait ~2 minutes for the first deploy. Render gives you a public URL like
   `https://sync-audio-xxxx.onrender.com`.

### Step 3 — Use it
Both people open that same `https://sync-audio-xxxx.onrender.com` link —
from any network, any city, any country. One hosts, gets the room code,
shares it (text/WhatsApp), the other joins. Same Play button, same sync
logic — it just runs on Render's server instead of your laptop.

### One real limitation of the free Render tier
Free services "sleep" after 15 minutes of no traffic and take ~30-50
seconds to wake back up on the next request. If the site feels stuck
loading the first time, that's why — just wait, it's not broken. Refresh
after a minute if needed.

### About accuracy at long distance
At 50km apart, the two of you are never in the same physical room hearing
both speakers overlap — so millisecond-level precision doesn't matter the
way it did for the WiFi echo problem. A gap of a few hundred ms is
unnoticeable when you're not standing next to both speakers at once. The
sync math already built in still helps (it's the same code), it's just a
lower bar to clear now.

