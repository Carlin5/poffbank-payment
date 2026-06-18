# Bitcart Self-Hosted Setup — PoffBank Payment Gateway

This guide stands up a **self-hosted, no-KYB** Bitcart instance and wires it
into this app as a third payment method, alongside the existing NOWPayments
hosted checkout and direct-USDT flows.

Why Bitcart: it's a free, open-source, non-custodial crypto invoicing stack.
**You run the node and the wallet**, so there is no third-party payment
processor to verify your business — the funds go directly into wallets you
control. The existing NOWPayments flow stays in place for users who prefer it.

---

## 1. Provision a VPS

Recommended specs for BTC + ETH + USDT-TRC20 + USDT-Polygon:

| Resource | Minimum | Recommended |
|---|---|---|
| vCPU      | 2 cores       | 4 cores |
| RAM       | 4 GB          | 8 GB |
| Disk      | 80 GB SSD     | 200 GB NVMe (BTC pruned node is ~10 GB; ETH SPV is light) |
| OS        | Ubuntu 22.04  | Ubuntu 22.04 LTS |
| Provider  | Hetzner / Contabo / DigitalOcean / Vultr | any KVM/cloud host |

Open inbound TCP **22, 80, 443** in your firewall. Point a domain (e.g.
`pay.your-domain.com` and `admin.pay.your-domain.com`) at the server's IP via
two `A` records.

---

## 2. Install Docker and Bitcart

```bash
# As root or with sudo
apt update && apt install -y curl git
curl -fsSL https://get.docker.com | sh

git clone https://github.com/bitcart/bitcart-docker
cd bitcart-docker
```

Configure the instance (interactive — answer the prompts):

```bash
# Public hostnames
./setup-env.sh BITCART_HOST=pay.your-domain.com \
               BITCART_ADMIN_HOST=admin.pay.your-domain.com \
               BITCART_STORE_HOST=store.your-domain.com \
               LETSENCRYPT_EMAIL=you@your-domain.com

# Choose which coins to run. For our supported set:
./setup.sh btc eth trx matic tor
#   btc   → Bitcoin
#   eth   → Ethereum (incl. ERC-20 USDT)
#   trx   → Tron (incl. TRC-20 USDT)
#   matic → Polygon (incl. Polygon USDT)
#   tor   → optional Tor hidden service
```

`setup.sh` will pull the relevant daemons + admin + store + API images and
start them all behind a Caddy reverse proxy that auto-issues Let's Encrypt
certs. First boot takes 5–15 min while wallets sync.

Verify it's up:

```bash
docker ps
curl -I https://admin.pay.your-domain.com   # expect 200
```

---

## 3. Create wallets + a store + a webhook

You have **two options**: a one-shot automated bootstrap (recommended) or
clicking through the admin UI.

### Option A — Automated bootstrap (recommended, ~30 seconds)

1. Open `https://admin.pay.your-domain.com` and create the admin account.
2. **Manage Tokens → New Token** with the `server_management` permission.
   Copy the token immediately — Bitcart only shows it once.
3. From this repo, run the bootstrap script. It creates the USDT TRC-20
   wallet pointing at `TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6`, builds the store,
   wires the signed webhook back to your Render API, and prints the env
   vars you need:

   ```bash
   BITCART_API_URL=https://admin.pay.your-domain.com \
   BITCART_BOOTSTRAP_TOKEN=<paste token from step 2> \
   BASE_URL=https://poffbank-api.onrender.com \
   npm run bootstrap-bitcart
   ```

   Add `BTC_WALLET=…`, `ETH_WALLET=…`, `USDT_POLYGON_WALLET=…` env vars
   before running if you want those wallets provisioned too. The script is
   **idempotent** — re-running it reuses anything that already exists.

### Option B — Manual via the admin UI

1. Open `https://admin.pay.your-domain.com` and create the admin account.
2. **Wallets → New Wallet** for each coin. For each one paste the xpub /
   address / private key (your choice — Bitcart can also generate them).
   - **USDT TRC-20:** point at `TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6`
   - Add BTC, ETH, USDT-Polygon as desired.
3. **Stores → New Store** ("PoffBank"). Attach the wallets from step 2.
4. Note the **Store ID** — visible in the URL `…/stores/{ID}/edit`.
5. In the store → **Webhooks → New Webhook**:
   - URL: `https://poffbank-api.onrender.com/api/webhook/bitcart`
   - Secret: generate a strong random string (32+ chars). Keep it — you'll
     paste it into this app's env as `BITCART_WEBHOOK_SECRET`.
   - Events: at minimum `invoice_paid`, `invoice_complete`, `invoice_expired`,
     `invoice_invalid`. Bitcart wraps these into `data.status` which we map
     in `mapBitcartStatus()` (`@server-clean.js:330`).
6. **Manage Tokens → New Token** with `server_management` permission. Copy
   the token immediately — Bitcart only shows it once.

---

## 4. Plug it into this app

Set these four env vars on your Render service (Environment → Add Variable):

```bash
BITCART_API_URL=https://admin.pay.your-domain.com
BITCART_API_TOKEN=<paste the Manage Tokens token>
BITCART_STORE_ID=<paste the store id>
BITCART_WEBHOOK_SECRET=<paste the same secret you set on the store webhook>
```

Optional, if your public store URL differs from the admin URL:

```bash
BITCART_CHECKOUT_URL_TEMPLATE=https://store.your-domain.com/i/{id}
```

Click **Manual Deploy → Deploy latest commit** (or just save — Render
auto-redeploys on env change). On boot you'll see:

```
Bitcart:        enabled (https://admin.pay.your-domain.com)
```

---

## 5. Verify end-to-end

```bash
# 1. Config should now show bitcart = true
curl https://poffbank-api.onrender.com/api/config | jq

# 2. Create an invoice from the API
curl -X POST https://poffbank-api.onrender.com/api/bitcart-invoice \
     -H 'Content-Type: application/json' \
     -d '{"amount": 5, "description": "Bitcart smoke test"}'
# → { success: true, invoiceUrl: "https://admin.pay…/i/<id>" }
```

Open `/pay.html` — you'll see a third tile: **Self-hosted (Bitcart)**. Pick
it, enter an amount, submit. You'll be redirected to Bitcart's hosted
checkout where the customer picks BTC / ETH / USDT / etc. and pays. As soon
as Bitcart confirms on-chain, the signed webhook hits this app, the order
flips to `completed`, and the `/success.html` polling page shows the receipt.

---

## 6. Security checklist

- **Bitcart admin:** enable 2FA. Use a strong unique password.
- **Wallets:** for high volume use **xpub-only** in Bitcart and keep the
  private keys / seed offline (hardware wallet). Bitcart will then watch the
  addresses for incoming payments without holding the keys.
- **Webhook secret:** treat it like an API key. Rotate if leaked.
- **Backups:** snapshot the VPS daily. Export the Bitcart DB (`docker exec`
  + `pg_dump`) weekly.
- **Updates:** `cd bitcart-docker && git pull && ./setup.sh ...` updates the
  stack.

---

## 7. What still routes through NOWPayments

Nothing forced. Both flows stay live and the customer picks. The Hosted
Checkout tile (`/api/invoice`) goes through NOWPayments; payouts auto-forward
to your USDT-TRC20 wallet as configured in their dashboard. The new Bitcart
tile (`/api/bitcart-invoice`) is fully self-hosted and bypasses any KYB on a
processor account, since *you are the processor*. The direct-USDT tile
remains unchanged: customer sends straight to the wallet, we verify the tx
on Tron via TronGrid.

---

## 8. Troubleshooting

- **Boot log says `Bitcart: disabled`** — at least one of the four required
  env vars is missing. Check Render → Environment.
- **`/api/bitcart-invoice` returns 502** — the server reached Bitcart but
  Bitcart rejected the call. Look at server logs (`[bitcart-invoice] error`)
  — usually a bad `store_id` or a token without `server_management` perms.
- **Webhook 401 mismatch in logs** — `BITCART_WEBHOOK_SECRET` here doesn't
  match the secret on the Bitcart store webhook. Re-paste both sides.
- **Invoice page loads but never confirms** — check the wallet sync status
  in Bitcart admin (Wallets → tap the wallet → "Last block"). If the daemon
  is still syncing it can't see incoming payments yet.
