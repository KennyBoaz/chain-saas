# Wina Classic Uganda — WhatsApp bot backend

Node.js + Express backend that:

1. Receives WhatsApp messages from Meta's Cloud API webhook
2. Keeps a short conversation history per customer phone number
3. Asks **Gemini** (`gemini-3.8-flash`) for a natural reply
4. Runs Gemini function calls locally (availability, booking, orders, tickets, human handoff)
5. Sends the final text back to the customer on WhatsApp

## Files

| File | What it does |
| --- | --- |
| `server.mjs` | Express app, GET/POST `/webhook` |
| `whatsapp.mjs` | Parse incoming messages, send replies |
| `gemini.mjs` | Gemini call + function-calling loop |
| `tools.mjs` | The 5 tools and their Gemini schemas |
| `memory.mjs` | In-memory history (swap this for a database later) |
| `systemPrompt.mjs` | **Paste your business prompt here** |
| `.env.example` | Environment variable names (local development only) |

## Gemini model

This project uses **`gemini-3.8-flash`**.

That is Google's current generally-available Flash model (as of 20 Sep 2026). You originally asked for `gemini-2.5-flash`; that name still works today, but Google has indicated it may shut down as early as 16 Oct 2026.

To change the model, either edit `GEMINI_MODEL` in `gemini.mjs` or set:

```
GEMINI_MODEL=gemini-2.5-flash
```

in `.env`.

The code uses Google's current SDK: `@google/genai` (`import { GoogleGenAI } from "@google/genai"`). The older `@google/generative-ai` package is deprecated and is not used.

## 1. Install

You need **Node.js 18 or newer**.

```bash
cd Bot
npm install
```

## 2. Configure environment variables

```bash
copy .env.example .env
```

Then open `.env` and fill in:

| Variable | Where to get it |
| --- | --- |
| `WHATSAPP_TOKEN` | Meta Developer dashboard → WhatsApp → API Setup → Temporary (or permanent) access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Same page, next to your test phone number |
| `WEBHOOK_VERIFY_TOKEN` | Invent any secret string. You will paste the **same** string into Meta. |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `PORT` | Optional. Defaults to `3000`. |

If you already stored a Gemini key in `Local.ENV`, copy that value into `GEMINI_API_KEY`. Do not commit `.env`.

## 3. Paste your system prompt

Open `systemPrompt.mjs` and replace the placeholder string marked:

```
REPLACE WITH BUSINESS SYSTEM PROMPT
```

## 4. Run locally

```bash
npm start
```

You should see:

```
Wina Classic WhatsApp bot listening on http://localhost:3000
```

`npm run dev` does the same thing, but restarts the server when you save a file.

Open http://localhost:3000/health in a browser. You should see `{"ok":true,...}`.

## 5. Expose the webhook with ngrok

Meta cannot call `localhost`. Use [ngrok](https://ngrok.com/) (or Cloudflare Tunnel) so Meta has a public HTTPS URL.

```bash
ngrok http 3000
```

Copy the `https://....ngrok-free.app` URL. Your webhook path is:

```
https://YOUR-SUBDOMAIN.ngrok-free.app/webhook
```

## 6. Connect the webhook in Meta

1. Open [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp** → **Configuration**.
2. Click **Edit** on the webhook callback URL.
3. Callback URL: `https://YOUR-SUBDOMAIN.ngrok-free.app/webhook`
4. Verify token: the exact value of `WEBHOOK_VERIFY_TOKEN` from `.env`
5. Click **Verify and save**. Meta sends a GET request; this server echoes `hub.challenge` if the token matches.
6. Subscribe to the **messages** field.

Keep ngrok **and** `npm start` running while you test. A free ngrok URL changes every time you restart ngrok, so you will need to update the callback URL if that happens.

## 7. Send a test message

In the Meta dashboard, use the test phone number to message your WhatsApp business number. You should see the incoming payload in the Node terminal, then a Gemini reply on WhatsApp.

Dummy bookings / orders / tickets are written as JSON files under `data/`.

If Gemini's free tier is exhausted, the terminal prints a clear **GEMINI FREE-TIER RATE LIMIT HIT (HTTP 429)** banner. The customer gets a short "please try again" message and the server keeps running.

## Tool stubs

These are real functions, but they only log to JSON for now:

- `check_availability` — returns dummy Kampala-time slots
- `book_appointment` — appends `data/appointments.json`
- `create_order` — appends `data/orders.json`
- `create_support_ticket` — appends `data/tickets.json`
- `escalate_to_human` — appends `data/escalations.json` and prints a console alert (this is where Slack/email would go later)

## Swapping memory for a database

See the long comment at the top of `memory.mjs`. Keep `getHistory` / `saveHistory` and you will not need to rewrite `server.mjs`.

## cPanel (Namecheap Node.js Selector)

The app files are `.mjs` so the process starts as ES Modules. In **Setup Node.js App**:

- Set **Application Startup File** to `server.mjs` (not `server.js`).
- Set environment variables in the **Environment Variables** panel (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`, `GEMINI_API_KEY`, and optional `PORT`, `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`). Do not rely on a `.env` file there. With Application mode set to **Production**, `NODE_ENV` is `production` and the app does not load dotenv.
- After uploading this version, click **Run NPM Install** again, then restart the app. The startup file changed, so the selector needs to reinstall and relaunch against `server.mjs`.

Local `npm start` is unchanged: if `.env` is present and `NODE_ENV` is not `production`, the server still loads it.
