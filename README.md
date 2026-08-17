# ShopiBot

**Your store's AI shopping assistant — drop it in, done.**

ShopiBot is a lightweight, self-hosted chatbot widget for Shopify stores. It floats in the bottom-right corner of your storefront, goes full-screen on mobile, and answers customer questions using Google Gemini — all without exposing API keys or paying per-conversation SaaS fees. Drop it onto any page, and your store gets a 24/7 shopping assistant that handles product discovery, order tracking, returns, and pre-purchase Q&A.

---

## Features

- **Floating chat widget** — branded bubble in the bottom-right; slides open on click
- **Full-screen mobile mode** — native-feeling experience on phones (73% of ecommerce traffic)
- **Quick-reply buttons** — guided conversation starters, not a blank text field
- **Typewriter responses** — natural-feeling message reveal with typing indicator
- **Session memory** — conversation history persists across page refreshes
- **Error handling** — graceful fallbacks with retry when the API is unreachable
- **Zero external dependencies** — pure HTML/CSS/JS, ~32 KB total
- **Secure architecture** — API key stays server-side in the Cloudflare Worker, never touches the browser

---

## Quick Start

### 1. Deploy the Cloudflare Worker

```bash
cd shopify-chatbot
wrangler deploy
wrangler secret put GEMINI_API_KEY
# Paste your Gemini API key when prompted
```

Copy the deployed Worker URL (e.g. `https://shopify-chatbot-worker.YOUR_SUBDOMAIN.workers.dev/`).

### 2. Configure the Worker URL

Open `js/app.js` and replace `YOUR_SUBDOMAIN` in the `WORKER_URL` constant with your actual subdomain.

### 3. Deploy to GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to `main` branch, root folder
4. Your shopbot is live at `https://<your-username>.github.io/shopify-chatbot/`

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | HTML / CSS / JS | No build step, no framework, minimal footprint |
| Hosting | GitHub Pages | Free static hosting with HTTPS |
| API Proxy | Cloudflare Worker | Hides API key server-side, handles CORS, 100K free requests/day |
| LLM | Google Gemini 2.5 Flash | Fast, cost-effective, strong at conversational commerce |

---

## Project Structure

```
shopify-chatbot/
├── index.html          # App shell + demo page + widget HTML
├── css/
│   └── styles.css      # Widget styles, responsive breakpoints, animations
├── js/
│   └── app.js          # Chat logic, state management, API calls
├── worker.js           # Cloudflare Worker (Gemini API proxy)
└── wrangler.toml       # Worker deployment config
```

---

## Roadmap

**Phase 1** (current) — Basic framework with conversational product Q&A and guided quick replies. No live Shopify data yet.

**Phase 2** — Streaming responses (token-by-token), real Shopify product catalog via API, order lookup, proactive greetings on product pages, analytics, and live human handoff.

---

## License

Built for the Shopi store. MIT — use it however you like.
