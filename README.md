# ACGE Cloud Browser (public runner host)

Free, cloud-only host for the Playwright browser runtime used by Arabic Consultant
Growth Engine. Runs on GitHub Actions (public repo = free minutes) and publishes a
Cloudflare quick-tunnel URL to the private dashboard via `BROWSER_AGENT_URL`.

## Secrets required (set in this repo)
- `BROWSER_AGENT_TOKEN`
- `BROWSER_AGENT_ENCRYPTION_KEY`
- `VERCEL_TOKEN`
- Variable `APP_URL` (e.g. https://arabic-consultant-growth-engine.vercel.app)

## Run
Actions → "Cloud browser runner" → Run workflow → choose minutes (5-350).
