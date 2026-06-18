# PoffBank Payment Gateway

Secure payment processing gateway for PoffBank with NOWPayments backend integration for USDT conversion.

## Features

- **Clean PoffBank Branding**: Customers see only professional PoffBank branding
- **NOWPayments Backend**: USDT conversion handled entirely on the backend
- **Secure Processing**: Card data handled with bank-grade security
- **Real-time Processing**: Live payment status updates
- **Professional Receipts**: Detailed transaction confirmations

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Customer UI   │ ───► │  PoffBank Server │ ───► │  NOWPayments API │
│  (index.html)   │      │   (server.js)    │      │  (USDT Backend) │
└─────────────────┘      └──────────────────┘      └─────────────────┘
      PoffBank                  PoffBank               Hidden from
      Branding                  API Layer               Customer
```

**Customer sees only**: Clean PoffBank branding, professional payment flow
**Backend handles**: NOWPayments API integration, USDT wallet configuration

## Installation

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Edit `.env` file:

```env
# Server Configuration
PORT=3000
BASE_URL=http://localhost:3000

# NOWPayments API (already configured)
NOWPAYMENTS_API_KEY=BT0AHVQ-MM8M4Z2-H57T2NC-V4EM2QG
```

### 3. Start the Server

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

### 4. Open Payment Gateway

Navigate to: `http://localhost:3000`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health check |
| `/api/exchange-rate` | GET | USD to USDT exchange rate |
| `/api/payment/create` | POST | Create new payment |
| `/api/payment/status/:orderId` | GET | Check payment status |
| `/api/payment/callback` | POST | NOWPayments webhook |
| `/api/payment/complete` | POST | Complete payment |

## Payment Flow

1. **Customer** fills payment form on PoffBank-branded UI
2. **Frontend** sends payment data to PoffBank backend
3. **Backend** creates NOWPayments payment (USDT conversion configured)
4. **Backend** processes card payment (integrate Stripe/Braintree in production)
5. **Backend** confirms payment and generates receipt
6. **Customer** sees success modal with PoffBank receipt

## Card → USDT setup

**Out of the box, no configuration needed.** The "Pay with card" tile on `/pay.html` shows a chooser of three globally-available, no-KYB card processors. The customer picks whichever works in their region; whichever they pick, USDT (TRC-20) settles directly to `TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6` on-chain.

| Provider             | Merchant KYB | Coverage              | Notes                                                                                                                  |
|----------------------|--------------|-----------------------|------------------------------------------------------------------------------------------------------------------------|
| `changenow`          | **No**       | Global (200+ countries) | **Default.** Aggregator that routes through Mercuryo, Simplex, Wert, Banxa.                                            |
| `guardarian`         | **No**       | 190+ countries        | Aggregator routing primarily through Mercuryo. Strong Africa coverage including Uganda.                                |
| `moonpay-public`     | **No**       | Limited (no Uganda, etc.) | MoonPay's public consumer URL with your wallet preset. Kept for customers in MoonPay-supported regions.                |
| `transak`            | **Yes**      | 150+ countries        | Set `TRANSAK_API_KEY` + `TRANSAK_WEBHOOK_SECRET` in env after KYB approval. Branded, signed-webhook flow.              |
| `moonpay`            | **Yes**      | 160+ countries        | Set `MOONPAY_API_KEY` + `MOONPAY_SECRET_KEY` in env after KYB approval. Branded, signed-webhook flow.                  |
| `nowpayments-card`   | No (account) | Per Simplex/Mercuryo  | Opt-in via `CARD_ONRAMP_NOWPAYMENTS_FALLBACK=true`. Needs a NOWPayments account whose KYB is approved + 3 dashboard toggles. |

In every case, the destination is your USDT TRC-20 wallet (`USDT_TRC20_WALLET`, defaults to `TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6`). Card data never touches this server.

### How the customer experience works

1. Customer opens `/pay.html`, enters amount / email, picks "Pay with card".
2. They see a chooser of all the enabled processors (with a "Global" badge on aggregators and a "Limited regions" badge on MoonPay).
3. They pick one — defaulting to ChangeNOW — and click "Continue to Card Payment".
4. They are redirected to that provider's hosted page with your wallet locked in the URL. They complete the provider's KYC and pay by card. USDT TRC-20 settles on-chain to your merchant wallet.
5. If a processor says "not supported in your region", the customer hits Back and picks another one. No order is consumed.

### NOWPayments Card Setup (optional upgrade)

If you want to switch from `moonpay-public` to `nowpayments-card` (Simplex / Mercuryo branded flow with slightly better region coverage), do these steps:

1. Set `CARD_ONRAMP_NOWPAYMENTS_FALLBACK=true` in your environment.
2. **NOWPayments → Store Settings → Payment Methods** → enable "Buy crypto with card (Simplex / Mercuryo)".
3. **NOWPayments → Payment Settings** → set USDT-TRC20 payout wallet to `TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6`.
4. **NOWPayments → Store Settings → IPN Secret Key** → generate one and set `NOWPAYMENTS_IPN_SECRET` in your env.
5. **NOWPayments → Store Settings → IPN Callback URL** → `https://<your-domain>/api/webhook/nowpayments`.

## Production Deployment

### 1. Update Environment Variables

```env
BASE_URL=https://payments.poffbank.com
NOWPAYMENTS_API_KEY=your-production-api-key
NOWPAYMENTS_IPN_SECRET=your-ipn-signing-secret    # from NOWPayments dashboard
USDT_TRC20_WALLET=TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6
```

### 2. Configure Webhook in NOWPayments

Set IPN callback URL to your production domain:
```
https://payments.poffbank.com/api/webhook/nowpayments
```

### 3. (Optional) Upgrade to a branded card processor

After you pass KYB with Transak or MoonPay, add their keys to `.env` /
Render and the "Pay with card" button automatically switches to that
provider's branded, signed checkout. No code change needed.

### 4. Deploy

```bash
# Example deployment commands
npm install --production
npm start
```

## Security Notes

- API keys are stored in `.env` (never exposed to frontend)
- Card data never touches your server (use Stripe Elements in production)
- NOWPayments handles all USDT conversion
- Customer sees only PoffBank branding

## Support

For NOWPayments support: https://nowpayments.io/help
For PoffBank: Contact your account manager

---

**PoffBank Panama Offshore Bank** - Secure offshore financial services

---

## Clean Implementation (recommended)

The original `server.js` collected raw card data and tried to bridge Flutterwave
charges to NOWPayments invoices, which doesn't actually move money to your USDT
wallet. The clean replacement is `server-clean.js` and uses NOWPayments' hosted
invoice the way it's designed to be used.

### Flow

1. Customer opens `/pay.html` and enters amount + email.
2. Frontend calls `POST /api/invoice` → backend calls NOWPayments `/v1/invoice`.
3. Customer is redirected to the NOWPayments hosted page and pays in USDT/BTC/etc.
4. NOWPayments converts (if needed) and settles **USDT TRC-20** to the wallet
   configured in your NOWPayments dashboard payout settings.
5. NOWPayments calls `POST /api/webhook/nowpayments` with an HMAC-SHA512 signed
   payload; we verify it with `NOWPAYMENTS_IPN_SECRET` and update the order.
6. Frontend can poll `GET /api/payment/status/:orderId`.

### Run it

```bash
npm install
# fill NOWPAYMENTS_API_KEY and NOWPAYMENTS_IPN_SECRET in .env
npm start             # runs server-clean.js
npm run start:legacy  # (optional) old server, kept for reference
```

Then open `http://localhost:3000/pay.html`.

### What is NOT done by this server

- No raw card numbers, CVVs, or expiry dates ever touch this server. Card data
  is entered on NOWPayments' (or their on-ramp partner's) PCI-DSS compliant
  hosted page.
- No "simulation" success path. An order is only marked `completed` after a
  signed NOWPayments IPN confirms the on-chain settlement.
