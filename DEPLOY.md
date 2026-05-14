# PoffBank Secure Payments — Deploy Runbook

Single-origin deploy on **Render**. The same service serves the checkout
HTML, the JSON API, and the NOWPayments webhook. No frontend/backend split,
no CORS, no cross-host bugs.

---

## 0. Prerequisites (do these once)

1. **Rotate the NOWPayments API key.** The previous key was committed to
   `render.yaml` in git history and must be considered leaked.
   Dashboard → API keys → revoke old → create new.
2. **Generate the IPN secret.** NOWPayments dashboard →
   *Store Settings → IPN Secret Key* → generate. Copy it.
3. **Set your payout wallet.** NOWPayments dashboard → *Payment Settings*
   → payout wallet for `USDT (TRC-20)` →
   `TURXbzSQQKTiA6fqMzsZMaFQyXAU7o2nXh`.

---

## 1. Push to GitHub

```bash
git add -A
git commit -m "PoffBank Secure Payments: clean checkout, single-origin deploy"
git push
```

The repo now contains only the safe app at the root. The old unsafe
prototype is preserved under `legacy/` and is NOT served.

---

## 2. Create the Render service

1. <https://render.com> → **New + → Blueprint** → pick this repo.
2. Render reads `render.yaml` and proposes one web service:
   `poffbank-secure-payments`. Confirm.
3. When prompted for `sync: false` secrets, paste:
   - `NOWPAYMENTS_API_KEY` = your **rotated** key
   - `NOWPAYMENTS_IPN_SECRET` = the IPN secret from step 0.2
4. Click **Apply**.

Render builds and starts the service. First boot logs should include:

```
PoffBank Secure Payments
  Port:           10000
  Base URL:       https://poffbank-secure-payments.onrender.com
  Pay currency:   usdttrc20
  IPN endpoint:   https://poffbank-secure-payments.onrender.com/api/webhook/nowpayments
  Checkout page:  https://poffbank-secure-payments.onrender.com/pay.html
  IPN secret:     set
```

If `IPN secret: MISSING` appears, you forgot step 0.2 — set it in
*Render → Environment* and redeploy.

---

## 3. Pin the real hostname

Render will give the service a real subdomain, e.g.
`https://poffbank-secure-payments-abcd.onrender.com`.
Two env vars must reflect it exactly:

- `BASE_URL` = that URL
- `FRONTEND_URL` = that URL

Update both in **Render → Environment** → Save → **Manual Deploy →
Deploy latest commit**.

---

## 4. Tell NOWPayments where to call back

NOWPayments dashboard → *Store Settings* → IPN callback URL:

```
https://<your-render-host>/api/webhook/nowpayments
```

The route requires the signed `x-nowpayments-sig` header and rejects
unsigned or mis-signed requests with HTTP 401. Don't open it in a browser —
it isn't a UI.

---

## 5. Smoke test

```bash
# 1) Service is up and can reach NOWPayments
curl https://<host>/api/health

# 2) Checkout page renders
open https://<host>/pay.html         # macOS
start https://<host>/pay.html        # Windows
```

Submit a $1 invoice on `/pay.html`. You should land on the NOWPayments
hosted page. If you complete or cancel, you'll come back to
`/success.html?order_id=...` or `/cancel.html?order_id=...` and the page
will poll status until `completed` / `failed`.

---

## 6. Custom domain (optional)

1. **Render → Settings → Custom Domain** → add `pay.poffbank.com`.
2. Create a CNAME at your DNS pointing to the Render target Render shows you.
3. Once Render reports the cert is issued, update env:
   - `BASE_URL` = `https://pay.poffbank.com`
   - `FRONTEND_URL` = `https://pay.poffbank.com`
4. Update the NOWPayments IPN URL to the new host.
5. Manual deploy.

---

## Alternatives (same Procfile, same app)

| Provider | Verdict | Notes |
|---|---|---|
| **Render** | ✅ Default | Free tier sleeps after 15 min; Starter $7/mo for always-on. |
| **Railway** | ✅ | Reads the `Procfile`. Trial credits then ~$5/mo. |
| **Fly.io** | ✅ | `fly launch` from this repo; choose Node, accept defaults. |
| **VPS (Hetzner / DO / Contabo)** | ✅ | Run `node server-clean.js` under PM2 behind Nginx + Let's Encrypt. Most control. |
| **Vercel / Netlify** | ❌ for this app | Serverless model breaks the in-memory order store between invocations. Would require Mongo + a refactor. Use one of the above. |

---

## Known limitations / next steps

- **Orders are in memory.** On every Render redeploy or cold-start sleep,
  the in-memory `orders` map is lost. The user still gets a correct
  result, because `GET /api/payment/status/:orderId` falls back to
  asking NOWPayments directly, but internal records aren't durable.
  When you want durability, add MongoDB (the `MONGODB_URI` env var is
  already reserved in `.env.example`).
- **No admin panel** is exposed yet. Add one behind auth if you need
  ops visibility.
- **Free Render cold starts** can make `pay.html` take ~30s on first hit
  after sleep. Upgrade to Starter for production.
