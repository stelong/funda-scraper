# funda-scraper

A simple node.js script that goes to funda.nl and get the last day(s) of listings and push it to a Telegram chat via the Telegram Bot API.

## How to use
Add a search URL with your filters to the array `urls` in the file `main.js` and `CHAT_ID` and `BOT_API` to your environment variables.

## License
MIT


## GitHub Actions

- **Workflow**: `./github/workflows/scrape-and-notify.yml` — scheduled job that runs every 10 minutes and executes `npm run task`.
- **Secrets**: set these repository secrets in GitHub Settings → Secrets & variables → Actions before enabling the workflow:
	- **`BOT_API`**: Your Telegram Bot API token (the part after `bot` in the Telegram API URL; e.g. `123456:ABC-...`).
	- **`CHAT_ID`**: The chat id (or channel id) where messages should be sent.
- **Environment control**: The workflow sets `SEND_TELEGRAM=1` to enable sending. You can override or set `SEND_TELEGRAM=0` in the workflow if you want dry-runs.
- **Notes**: Puppeteer runs headless Chromium on the runner; workflow installs some system packages to satisfy Chromium's dependencies.
