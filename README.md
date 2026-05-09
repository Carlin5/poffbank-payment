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

## NOWPayments Setup

1. Log in to [NOWPayments Dashboard](https://account.nowpayments.io/)
2. Add your USDT TRC20 wallet address in settings
3. Your API key is already configured: `BT0AHVQ-MM8M4Z2-H57T2NC-V4EM2QG`
4. Webhook URL: `http://your-domain.com/api/payment/callback`

## Production Deployment

### 1. Update Environment Variables

```env
BASE_URL=https://payments.poffbank.com
NOWPAYMENTS_API_KEY=your-production-api-key
```

### 2. Configure Webhook in NOWPayments

Set IPN callback URL to your production domain:
```
https://payments.poffbank.com/api/payment/callback
```

### 3. Add Real Card Processing

In `server.js`, replace the simulated card processing with:
- Stripe
- Braintree
- Or your preferred payment processor

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
