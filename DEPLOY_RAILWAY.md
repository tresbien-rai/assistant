# Deploying to Railway (P0-18)

A follow-along guide for shipping the Personal AI Assistant to Railway.

This app is **one Express service** that does two jobs at once: it serves the API
(`/api/...`) *and* the frontend files (`index.html`, `app.js`, `styles.css`). So you
only deploy one thing. The tricky parts are (1) telling Railway to build/run the code
that lives in the `server/` subfolder, (2) giving it a **persistent disk** so your
database and avatar images survive restarts, and (3) wiring up **Google OAuth** with the
live URL.

Set aside ~30–45 minutes. You'll bounce between three browser tabs: **Google Cloud
Console**, **Railway**, and a terminal on your machine.

---

## Overview of what we're doing

1. Generate two production secrets on your machine.
2. Create the OAuth app in Google Cloud Console.
3. Create the Railway project from your GitHub repo.
4. Add a persistent Volume so data isn't wiped on every deploy.
5. Paste all the environment variables into Railway.
6. Get your live URL, then go back and finalize the Google + Railway redirect URI.
7. Verify it works.

> Heads-up about cost: Railway's free trial is time/credit limited. The Hobby plan
> (~$5/mo of usage) is what this is sized for. A tiny SQLite app like this uses very
> little.

---

## Step 1 — Generate production secrets (on your machine)

Your dev `.env` has throwaway secrets. Production needs fresh, strong ones. Open a
terminal and run this **twice**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- First output → this is your **`JWT_SECRET`** (signs login tokens).
- Second output → this is your **`ENCRYPTION_KEY`** (encrypts stored API keys + Google
  tokens). It must be exactly 64 hex characters, which this command guarantees.

Copy both somewhere safe for a few minutes (a scratch note). **Do not commit them** and
don't reuse the dev values.

> ⚠️ If you ever change `ENCRYPTION_KEY` later, every already-saved API key and Google
> token becomes unreadable and users must re-enter them. Pick it once and keep it.

---

## Step 2 — Set up Google OAuth (Google Cloud Console)

This is the part most likely to trip you up, so go slowly.

1. Go to <https://console.cloud.google.com/> and create a **new project** (top-left
   project dropdown → New Project). Name it anything, e.g. `ai-assistant`.
2. **Enable the APIs** you need. Go to *APIs & Services → Library* and enable:
   - **Google Drive API** (used in Phase 1, but enable it now so you don't redo this).
3. **Configure the OAuth consent screen** (*APIs & Services → OAuth consent screen*):
   - User type: **External**.
   - Fill in app name, your support email, developer email. The rest can stay blank.
   - **Scopes**: you can leave the defaults; the app requests Drive + profile scopes at
     login time.
   - **Test users**: add **your own Google email** (`3d59ad@gmail.com`). While the app is
     in "Testing" mode, only listed test users can sign in — that's fine for personal use.
     (You don't need to publish/verify the app just for yourself.)
4. **Create the credentials** (*APIs & Services → Credentials → Create Credentials →
   OAuth client ID*):
   - Application type: **Web application**.
   - Name: anything.
   - **Authorized redirect URIs**: for now add the local one so dev still works:
     `http://localhost:3000/api/auth/google/callback`
     (We'll add the live Railway URL in Step 6, once we know the domain.)
   - Click Create. Google shows you a **Client ID** and **Client Secret** — copy both.
     These become `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

---

## Step 3 — Create the Railway project

1. Go to <https://railway.app/> and sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick **`tresbien-rai/assistant`**.
   - If Railway can't see the repo, click "Configure GitHub App" and grant access to it.
3. Railway will create a service and try a first build. It's fine if this first attempt
   isn't perfect — we still need to add env vars and the volume. The build settings are
   already handled by the `railway.json` file in the repo root, which tells Railway to:
   - **Build:** `cd server && npm install`
   - **Start:** `cd server && npm start`

   This matters because the runnable code is in `server/`, but the frontend files
   (`index.html` etc.) are in the **repo root**. The server reaches "up and out" to the
   repo root to serve them, so Railway must build from the repo root (not from inside
   `server/`). The `railway.json` arrangement does exactly that — leave the service's
   **Root Directory** blank/default.

> You do **not** set a `PORT` yourself — Railway injects one automatically and the app
> reads it from `process.env.PORT`.

---

## Step 4 — Add a persistent Volume (don't skip this)

By default Railway gives each deploy a **fresh, empty filesystem**. This app writes two
things to disk:

- the SQLite database → `server/data/assistant.db`
- uploaded avatar/expression images → `server/data/avatars/`

Without a Volume, **every redeploy wipes your accounts, conversations, and avatars.** A
Volume is a disk that persists across deploys.

1. In your Railway service, open the **Variables/Settings** area and find **Volumes** →
   **New Volume** (also reachable by right-clicking the service in the canvas → Attach
   Volume).
2. Set the **Mount path** to:

   ```
   /app/server/data
   ```

   That's the exact folder the app reads and writes. Mounting the volume there means both
   the database and the avatars live on persistent disk with **zero code or env changes**.
3. A small size (1 GB) is plenty.

> Why `/app/server/data`? Railway puts your repo at `/app`, so the server runs from
> `/app/server` and its data folder is `/app/server/data`. The DB path and avatar path
> both default into that folder, so mounting the volume over it captures both.

---

## Step 5 — Set environment variables in Railway

In the service's **Variables** tab, add these (Raw Editor lets you paste them all at once):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | *(first secret from Step 1)* |
| `ENCRYPTION_KEY` | *(second secret from Step 1)* |
| `GOOGLE_CLIENT_ID` | *(from Step 2)* |
| `GOOGLE_CLIENT_SECRET` | *(from Step 2)* |
| `GOOGLE_REDIRECT_URI` | `https://YOUR-APP.up.railway.app/api/auth/google/callback` |

Notes:
- **`NODE_ENV=production` is required**, not optional. It turns on login-cookie security
  (the `Secure` flag, so cookies only travel over HTTPS) and makes the server insist that
  `JWT_SECRET`/`ENCRYPTION_KEY` are present — it will refuse to start without them.
- You don't yet know `YOUR-APP.up.railway.app` — that's fine. Put a placeholder for now
  and fix it in Step 6.
- Do **not** set `PORT` (Railway provides it) and you don't need `DB_PATH` or
  `STATIC_PATH` (the defaults are correct for this layout).

---

## Step 6 — Get your URL and finalize the redirect URI

OAuth is strict: the redirect URL your app sends must **exactly** match one registered in
Google. Now that the service exists, lock it in.

1. In Railway: **Settings → Networking → Generate Domain** (if it didn't auto-generate).
   You'll get something like `assistant-production-1a2b.up.railway.app`. Copy it.
2. **Railway:** update the `GOOGLE_REDIRECT_URI` variable to the real domain:
   `https://assistant-production-1a2b.up.railway.app/api/auth/google/callback`
3. **Google Cloud Console:** *Credentials → your OAuth client → Authorized redirect URIs*
   → **Add** the exact same URL. Save. (Google can take a minute or two to propagate.)
4. Changing the variable triggers a redeploy. Wait for it to finish.

> The path is always `/api/auth/google/callback`. The three places that must match are:
> the Railway `GOOGLE_REDIRECT_URI` var, the Google "Authorized redirect URI", and the
> live domain. A single typo here is the #1 cause of an OAuth "redirect_uri_mismatch"
> error.

---

## Step 7 — Verify

Open `https://YOUR-APP.up.railway.app` and check:

- [ ] The **login screen** loads (frontend is being served — confirms static files work).
- [ ] **"Sign in with Google"** redirects to Google, you pick your account, and you land
      back in the app logged in (confirms OAuth + cookie + DB write).
- [ ] Create a **persona**, send a **chat message** (after saving an API key in settings),
      and confirm a reply (confirms DB + the encrypted API-key flow + provider proxy).
- [ ] Upload an **avatar image**, then in Railway hit **Redeploy** — after it restarts,
      the avatar and your data should **still be there** (confirms the Volume works).
- [ ] If something fails, open Railway's **Deploy Logs** / **Observability** tab — the
      server logs (via pino) will show the error.

Common first-deploy issues:
- **"redirect_uri_mismatch"** → the three URLs in Step 6 don't match exactly (http vs
  https, trailing slash, wrong domain).
- **App won't start, logs say "Missing required environment variables"** → `JWT_SECRET` or
  `ENCRYPTION_KEY` not set (Step 5).
- **Login works but you're logged out on refresh** → make sure `NODE_ENV=production` is
  set (cookie `Secure` flag needs HTTPS, which Railway provides).
- **Data disappears after redeploy** → the Volume mount path isn't exactly
  `/app/server/data` (Step 4).

---

## One small code improvement worth making (optional)

The app runs behind Railway's proxy. The per-user rate limiter identifies callers by IP,
and behind a proxy Express needs `app.set('trust proxy', 1)` to read the real client IP
from the `X-Forwarded-For` header. Without it, `express-rate-limit` (v8) logs a validation
warning and may rate-limit everyone as if they share one IP. It won't stop the app from
working, but it's a clean one-line fix I can add on a branch before you deploy if you'd
like. (Auth still works fine without it because the OAuth redirect URI is set explicitly.)
