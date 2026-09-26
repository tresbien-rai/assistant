# Phase 0 Smoke-Test Checklist

Run this against the **live Railway URL** after deploying (and again any time we ship a
big change). It walks every main function end-to-end. Check boxes as you go; jot what
broke next to anything that fails so we can triage it together.

**How to read each item:** *Action* → **Expected**. If the expected thing doesn't happen,
it's a failure — note the symptom (and grab the browser console + Railway Deploy Logs if
it's a server error).

> Tip: open the browser **DevTools Console** (F12) while testing. A clean console = good
> sign. Red errors = copy them for triage. On a server error, also check Railway →
> service → **Deploy Logs**.

---

## 0. First load & infrastructure

- [ ] Visit `https://YOUR-APP.up.railway.app` → **login screen appears** (no blank page,
      no 500). Confirms the server is up and serving the frontend.
- [ ] `https://YOUR-APP.up.railway.app/api/health` → returns **`{"status":"ok"}`**.
- [ ] Page loads over **HTTPS** with no mixed-content or CORS errors in the console.

## 1. Authentication

- [ ] Click **Sign in with Google** → redirected to Google's account chooser.
- [ ] Pick your account → redirected **back into the app, logged in** (chat UI visible,
      your name/email shows).
- [ ] **Refresh the page** → still logged in (session cookie persists, no bounce to login).
- [ ] Open the app in a **second browser/incognito** → it shows the **login screen**
      (not your session — confirms per-user isolation).
- [ ] Click **Logout** → returns to login screen. Refresh → still logged out.
- [ ] (Cookie check) After login, DevTools → Application → Cookies: the `token` cookie is
      **HttpOnly** and **Secure**. Confirms `NODE_ENV=production` took effect.

## 2. Personas

- [ ] **Create** a new persona (name, system prompt, prefill, model). → appears in the list.
- [ ] **Edit** it (change the system prompt) → save → reopen → change persisted.
- [ ] **Switch** between personas → active persona updates; chat uses the selected one.
- [ ] Set a **model / model config** on a persona → it's what actually gets used when you
      chat (verify the reply style/model matches).
- [ ] **Delete** a persona → removed from list; its conversations handled gracefully.
- [ ] **Refresh** → all persona changes survived (loaded from server, not just memory).

## 3. Avatars & expressions

- [ ] **Upload an avatar image** to a persona → it displays (floating avatar + persona UI).
- [ ] Upload **expression images** (e.g. happy/sad) → they're stored.
- [ ] In a reply, when the AI emits `[expression: happy]` → tag is **stripped from the
      visible text** and the **avatar switches** to the matching image/emoji.
- [ ] **Delete** an avatar → reverts to default; no broken image icon.
- [ ] Avatar URL loads directly (right-click avatar → it's served from `/api/avatars/...`).

## 4. Conversations & messages

- [ ] **Start a new conversation** → it appears in the sidebar.
- [ ] Send a few messages → they persist in order.
- [ ] **Rename** a conversation → title updates and sticks after refresh.
- [ ] **Switch** between conversations → each shows its own correct message history (no
      bleed-over between threads).
- [ ] **Edit** a message → updated content saved.
- [ ] **Delete** a message → removed.
- [ ] **Rerun / retry** from a message → regenerates from that point.
- [ ] **Delete** a conversation → gone from sidebar; refresh confirms.

## 5. API keys

- [ ] Open settings → **save an API key** (e.g. Anthropic) → confirmation toast.
- [ ] Refresh → the key is **remembered as set** but the **raw key is never shown** back
      (masked / not pre-filled in plaintext).
- [ ] (Security) In DevTools → Network, inspect a chat request → **no plaintext API key**
      in the request body or anywhere client-side. Keys live server-side only.
- [ ] **Delete** an API key → chat with that provider then fails cleanly with a clear error.

## 6. Chat — the core flow

- [ ] **Streaming reply** (default): send a message → text **streams in token by token**.
- [ ] **Non-streaming** path (if togglable) also returns a complete reply.
- [ ] **Anthropic** provider works (with its key set).
- [ ] **Gemini** provider works (with its key set).
- [ ] **Stop / abort** mid-stream → generation halts, no error toast, partial text remains
      and the UI is usable again.
- [ ] **Attachments** (image/file) → send with a message → provider receives it and the
      reply reflects it.
- [ ] Long reply → scrolls/render correctly; markdown/code blocks format properly.

## 7. Settings

- [ ] Change **avatar size** → applies live and persists after refresh.
- [ ] Change **avatar position** → applies and persists.
- [ ] Toggle **show avatar** off/on → avatar hides/shows; persists.
- [ ] Add a **custom model** → it appears in the model selector and is usable.

## 8. Error handling (the P0-17 surfaces)

- [ ] **Inline chat error + Retry:** temporarily break it (e.g. delete the API key, or
      use an invalid key) → send a message → a **durable inline error bubble** appears in
      the thread with a code badge, expandable details, and a **Retry** button.
- [ ] Click **Retry** (after fixing the cause) → the message is re-sent and succeeds.
- [ ] Click **Retry while a response is still generating** → you get a "wait for the
      current response" **warning toast** and the error bubble is **not** destroyed.
- [ ] **Toast** appears for background/validation issues (bottom-right), auto-dismisses,
      and **stacks at most 3**; rapid duplicates are de-duped (not spammed).
- [ ] **Rate limit:** send messages rapidly to trip the limiter (30/min) → you get a
      **"Rate limit reached, try again in Ns"** message; after the wait, sending works again.
- [ ] **Session-expired path:** (hard to force) if the token expires, the app routes back
      to login rather than silently failing.

## 9. Cross-device sync & isolation

- [ ] Log in on a **second device/browser** as the **same** Google account → your personas,
      conversations, and settings are **all there** (server-synced, not local).
- [ ] Make a change on device A (new conversation) → reload device B → change shows up.
- [ ] (If you have a second Google account) log in as a **different** user → you see a
      **clean slate**, none of the first user's data. Confirms `user_id` isolation.

## 10. Volume persistence (the critical Railway check)

- [ ] With data created (account, a conversation, an uploaded avatar), go to Railway →
      **Redeploy** the service.
- [ ] After it restarts and you reload → **your data and avatar are still there.**
      ❗ If data is gone, the persistent Volume isn't mounted at `/app/server/data` — fix
      that before considering Phase 0 done.

## 11. Mobile / responsive

- [ ] Open on a phone (or DevTools device emulation) → layout adapts; avatar auto-shrinks.
- [ ] Sidebar/chat are usable; sending a message works on touch.
- [ ] No horizontal overflow or off-screen controls.

---

## Result summary

- Date tested: ____________  ·  Commit/URL: ____________
- Passed: ____ / Failed: ____
- Failures to triage (symptom + console/log snippet):
  1.
  2.
  3.

Once everything here passes against the live URL, **Phase 0 is complete** and we can move
on to Phase 1 (Google Drive project files).
