# mailroom

Your Gmail inbox, sorted: what matters, what's news, and what can go.

Three views, one screen:

- **Important** — emails that genuinely need your attention, picked by Claude
- **Digest** — your newsletters summarized into Last 24h / Last week / Older
- **Subscriptions** — promo traffic grouped by sender, with one-tap bulk archive

## How it works

- The browser signs into **Gmail directly** with Google OAuth (`gmail.modify` scope) and talks to the Gmail REST API — reading metadata and archiving messages.
- A **Vercel serverless function** (`api/summarize.js`) holds your Anthropic API key and asks Claude to classify and summarize. Only sender names, subjects, dates, and short snippets are sent to it — never full email bodies.
- No database. Nothing is stored server-side.

## Setup (one time, ~15 minutes)

### 1. Google Cloud — OAuth client

1. Go to https://console.cloud.google.com → create a project (e.g. "mailroom").
2. **APIs & Services → Library** → search **Gmail API** → Enable.
3. **APIs & Services → OAuth consent screen** → External → fill in app name + your email.
   - Under **Test users**, add your own Gmail address. (In testing mode only listed users can sign in — perfect for a personal app.)
   - Scopes: you can leave this blank; the app requests `gmail.modify` at runtime.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `http://localhost:5173`
     - your Vercel URL once you have it, e.g. `https://mailroom-yourname.vercel.app`
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### 2. Anthropic API key

1. Go to https://console.anthropic.com → API Keys → Create key.
2. Copy it. You'll set it as a Vercel environment variable (it is never exposed to the browser).

### 3. Push to GitHub

```bash
cd mailroom
git init
git add .
git commit -m "Mailroom v1"
# create an empty repo on github.com named mailroom, then:
git remote add origin https://github.com/YOUR_USERNAME/mailroom.git
git branch -M main
git push -u origin main
```

### 4. Deploy on Vercel

1. Go to https://vercel.com → **Add New → Project** → import the `mailroom` repo.
2. Framework preset: **Vite** (auto-detected). Leave build settings as default.
3. **Environment variables** (Project Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `VITE_GOOGLE_CLIENT_ID` = your Google OAuth Client ID
4. Deploy. Copy your live URL (e.g. `https://mailroom-yourname.vercel.app`).
5. **Back in Google Cloud → Credentials → your OAuth client** → add that URL to
   Authorized JavaScript origins. Save. (Takes effect within a few minutes.)

### 5. Put it on your iPhone

Open the Vercel URL in Safari → Share → **Add to Home Screen**. Done — it
launches full-screen like a native app.

## Local development

```bash
npm install
# .env file in the project root:
echo "VITE_GOOGLE_CLIENT_ID=your-client-id-here" > .env

# Frontend only (AI summaries will fail without the API function):
npm run dev

# Frontend + serverless function together (recommended):
npm i -g vercel
vercel dev   # prompts you to link the project; set ANTHROPIC_API_KEY when asked
```

## Costs

- Vercel: free tier is plenty.
- Gmail API: free.
- Anthropic API: each section load is one small Claude Sonnet call on metadata
  only — typically a fraction of a cent. See https://docs.claude.com for current pricing.

## Notes & troubleshooting

- **"Access blocked" on Google sign-in** → your email isn't in Test users, or
  the domain isn't in Authorized JavaScript origins.
- **Google token expires after ~1 hour** → the app detects this and shows the
  Connect button again; one tap re-authenticates.
- **Summaries fail but lists load** → `ANTHROPIC_API_KEY` missing/invalid in
  Vercel env vars. The Subscriptions tab still works without AI (it groups
  deterministically); Important and Digest need the key.
- Archiving uses Gmail's `batchModify` to remove the `INBOX` label — identical
  to pressing Archive in Gmail. Nothing is ever deleted.
