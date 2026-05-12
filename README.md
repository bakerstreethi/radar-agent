# radar-agent

Personal monitoring agent that searches the web using Claude AI and sends WhatsApp alerts via Twilio when new relevant information is found.

## What it does

- Reads a list of **radars** from `data/radars.json` — each radar has a topic, search queries, and a check frequency
- Searches the web using Claude's `web_search` tool
- Evaluates whether results are genuinely new (not previously seen)
- Sends a formatted **WhatsApp message** via Twilio only when something new is found
- Stays silent when nothing new is discovered

## Setup

```bash
npm install
```

Set the following environment variables:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude + web search) |
| `TWILIO_SID` | Twilio Account SID |
| `TWILIO_TOKEN` | Twilio Auth Token |
| `WHATSAPP_FROM` | Twilio WhatsApp sender (e.g. `whatsapp:+14155238886`) |
| `WHATSAPP_TO` | Your WhatsApp number (e.g. `whatsapp:+447700000000`) |

## Run

```bash
npm start
```

## Adding a radar

Add an entry to `data/radars.json`:

```json
{
  "id": "my-radar",
  "label": "My Topic",
  "intent": "What you are looking for",
  "queries": ["search query 1", "search query 2"],
  "frequency": "daily",
  "notify_threshold": "new_only",
  "active": true,
  "created_at": "2026-05-12T00:00:00Z",
  "last_checked": null,
  "last_result": null
}
```

Frequency options: `twice-daily`, `daily`, `weekly`

## WhatsApp message format

Uses WhatsApp markdown formatting with bold headers, emojis, and structured result listings. Stays silent when nothing new is found.

## Stack

- Node.js 18+ (ES modules)
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) — Claude API + web search
- [twilio](https://www.npmjs.com/package/twilio) — WhatsApp delivery
