/**
 * PoffBank Payment Gateway — Clean Implementation
 * --------------------------------------------------
 * Single, honest flow:
 *
 *   Customer  ──►  POST /api/invoice  ──►  NOWPayments /v1/invoice
 *                                              │
 *                                              ▼
 *                                   Hosted NOWPayments page
 *                                   (customer pays in USDT/BTC/etc.)
 *                                              │
 *                                              ▼
 *                          USDT settles to USDT_TRC20_WALLET
 *                          (configured in NOWPayments dashboard)
 *
 *   NOWPayments ──► POST /api/webhook/nowpayments  (HMAC-SHA512 signed IPN)
 *
 * No raw card data is ever collected, stored, or processed.
 * No "simulation" success path.
 * All payment state comes from NOWPayments — the single source of truth.
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FRONTEND_URL = process.env.FRONTEND_URL || BASE_URL;

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET; // set this in NOWPayments dashboard + .env
const NOWPAYMENTS_API_URL = 'https://api.nowpayments.io/v1';

const DEFAULT_PAY_CURRENCY = process.env.DEFAULT_CRYPTO_CURRENCY || 'usdttrc20';
const PRICE_CURRENCY = process.env.DEFAULT_CURRENCY || 'usd';
const COMPANY_NAME = process.env.COMPANY_NAME || 'PoffBank Secure Payments';
const COMPANY_SHORT = process.env.COMPANY_SHORT || 'PoffBank';

// Direct-to-wallet (Tron / USDT TRC-20) settings
const USDT_TRC20_WALLET = process.env.USDT_TRC20_WALLET || 'TURXbzSQQKTiA6fqMzsZMaFQyXAU7o2nXh';
const USDT_TRC20_CONTRACT = process.env.USDT_TRC20_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API_URL = process.env.TRONGRID_API_URL || 'https://api.trongrid.io';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY; // optional; raises rate limits

// Multi-coin payout wallets (used for display + future direct-pay-with-coin flows).
// Only USDT-TRC20 is currently auto-verified on-chain; the others are exposed
// in /api/config so the frontend / Bitcart store can use them.
const PAYOUT_WALLETS = {
  USDTTRC20: USDT_TRC20_WALLET,
  USDTPOLYGON: process.env.USDT_POLYGON_WALLET || '',
  BTC: process.env.BTC_WALLET || '',
  ETH: process.env.ETH_WALLET || '',
};

// ---------------------------------------------------------------------------
// Fiat → USDT card on-ramp (Transak primary, MoonPay optional)
// ---------------------------------------------------------------------------
// These providers accept the customer's card on their PCI-DSS compliant hosted
// page, handle KYC where required, convert the fiat to USDT, and settle the
// USDT on-chain directly to USDT_TRC20_WALLET. No card data ever touches this
// server.
//
// Provider precedence (first one with a key set wins, unless ?provider= is
// passed to /api/card-onramp):
//
//   1. transak  — https://transak.com (recommended; has STAGING for instant testing)
//   2. moonpay  — https://www.moonpay.com (production-only, requires KYC)
//
// Set TRANSAK_API_KEY (and optionally TRANSAK_ENVIRONMENT=PRODUCTION) to enable.
// Without any provider key, the card method is hidden in /api/config and the
// /api/card-onramp endpoint returns HTTP 503.
const TRANSAK_API_KEY = process.env.TRANSAK_API_KEY || '';
const TRANSAK_ENVIRONMENT = (process.env.TRANSAK_ENVIRONMENT || 'STAGING').toUpperCase();
const TRANSAK_WEBHOOK_SECRET = process.env.TRANSAK_WEBHOOK_SECRET || '';
// Tron-network USDT product code used by Transak. They've used both "USDT" with
// `network=tron` and the legacy `USDTTRC20`. We send both for compatibility.
const TRANSAK_CRYPTO_CODE = (process.env.TRANSAK_CRYPTO_CODE || 'USDT').toUpperCase();
const TRANSAK_NETWORK = (process.env.TRANSAK_NETWORK || 'tron').toLowerCase();
const TRANSAK_ENABLED = Boolean(TRANSAK_API_KEY && USDT_TRC20_WALLET);

const MOONPAY_API_KEY = process.env.MOONPAY_API_KEY || ''; // public/publishable key (pk_...)
const MOONPAY_SECRET_KEY = process.env.MOONPAY_SECRET_KEY || ''; // for URL signing + webhook verify
const MOONPAY_ENVIRONMENT = (process.env.MOONPAY_ENVIRONMENT || 'sandbox').toLowerCase();
// MoonPay's product code for USDT on Tron mainnet.
const MOONPAY_CURRENCY_CODE = (process.env.MOONPAY_CURRENCY_CODE || 'usdt_trx').toLowerCase();
const MOONPAY_ENABLED = Boolean(MOONPAY_API_KEY && USDT_TRC20_WALLET);

// Opt-in: route card payments through NOWPayments' hosted invoice, which
// supports "Buy with card" via Simplex/Mercuryo. Off by default because it
// requires three dashboard toggles in NOWPayments before it works (Payment
// Methods, Payout Wallet, IPN Secret). Set CARD_ONRAMP_NOWPAYMENTS_FALLBACK=true
// to enable this provider once the dashboard is set up. When off, the
// `moonpay-public` fallback (no merchant config needed) is the default.
const CARD_ONRAMP_NOWPAYMENTS_FALLBACK = String(process.env.CARD_ONRAMP_NOWPAYMENTS_FALLBACK || 'false').toLowerCase() === 'true';

// Public MoonPay consumer URL fallback (no API key, no merchant account).
// Customer goes through MoonPay's standard consumer KYC; USDT TRC-20 settles
// straight to USDT_TRC20_WALLET. Disable with CARD_ONRAMP_MOONPAY_PUBLIC=false.
// NB: MoonPay does NOT support a number of regions (e.g. Uganda) for card buys.
const CARD_ONRAMP_MOONPAY_PUBLIC = String(process.env.CARD_ONRAMP_MOONPAY_PUBLIC || 'true').toLowerCase() !== 'false';

// ChangeNOW public buy URL (aggregator routing through Mercuryo / Simplex /
// MoonPay / Wert / Banxa). No merchant account, no API key needed. Wider
// regional coverage than any single provider because the customer is matched
// at checkout to whichever sub-processor supports their country.
const CARD_ONRAMP_CHANGENOW = String(process.env.CARD_ONRAMP_CHANGENOW || 'true').toLowerCase() !== 'false';

// Guardarian public buy URL (aggregator routing primarily through Mercuryo).
// Documented 190+ country support; covers many regions MoonPay does not.
// No merchant account, no API key.
const CARD_ONRAMP_GUARDARIAN = String(process.env.CARD_ONRAMP_GUARDARIAN || 'true').toLowerCase() !== 'false';

const CARD_ONRAMP_ENABLED =
  TRANSAK_ENABLED ||
  MOONPAY_ENABLED ||
  CARD_ONRAMP_NOWPAYMENTS_FALLBACK ||
  CARD_ONRAMP_CHANGENOW ||
  CARD_ONRAMP_GUARDARIAN ||
  CARD_ONRAMP_MOONPAY_PUBLIC;

// Default provider when the customer doesn't pick one explicitly. ChangeNOW
// is the global-coverage default; MoonPay-public is last because of its
// regional limitations.
const CARD_ONRAMP_DEFAULT_PROVIDER =
  TRANSAK_ENABLED ? 'transak'
  : MOONPAY_ENABLED ? 'moonpay'
  : CARD_ONRAMP_NOWPAYMENTS_FALLBACK ? 'nowpayments-card'
  : CARD_ONRAMP_CHANGENOW ? 'changenow'
  : CARD_ONRAMP_GUARDARIAN ? 'guardarian'
  : CARD_ONRAMP_MOONPAY_PUBLIC ? 'moonpay-public'
  : null;

// ---------------------------------------------------------------------------
// Bitcart (self-hosted) settings — see BITCART_SETUP.md
// ---------------------------------------------------------------------------
// To enable the "Self-hosted (Bitcart)" payment method, set all four:
//   BITCART_API_URL       e.g. https://admin.your-bitcart.example.com
//   BITCART_API_TOKEN     a "Manage Tokens" → Server Management token
//   BITCART_STORE_ID      the numeric/uuid id of the Bitcart store
//   BITCART_WEBHOOK_SECRET  random string also configured in Bitcart store webhook
// BITCART_CHECKOUT_URL_TEMPLATE is optional and lets you point to a separate
// public store URL (e.g. https://pay.your-bitcart.example.com/i/{id}).
const BITCART_API_URL = (process.env.BITCART_API_URL || '').replace(/\/+$/, '');
const BITCART_API_TOKEN = process.env.BITCART_API_TOKEN || '';
const BITCART_STORE_ID = process.env.BITCART_STORE_ID || '';
const BITCART_WEBHOOK_SECRET = process.env.BITCART_WEBHOOK_SECRET || '';
const BITCART_CHECKOUT_URL_TEMPLATE = process.env.BITCART_CHECKOUT_URL_TEMPLATE
  || (BITCART_API_URL ? `${BITCART_API_URL}/i/{id}` : '');
const BITCART_ENABLED = Boolean(BITCART_API_URL && BITCART_API_TOKEN && BITCART_STORE_ID);

if (!NOWPAYMENTS_API_KEY) {
  console.error('[FATAL] NOWPAYMENTS_API_KEY is not set in environment.');
  process.exit(1);
}
if (!NOWPAYMENTS_IPN_SECRET) {
  console.warn('[WARN] NOWPAYMENTS_IPN_SECRET is not set — webhook signatures will be rejected.');
}
if (CARD_ONRAMP_ENABLED && TRANSAK_ENABLED && !TRANSAK_WEBHOOK_SECRET) {
  console.warn('[WARN] TRANSAK_WEBHOOK_SECRET is not set — Transak webhook callbacks will be rejected.');
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

const allowedOrigins = [
  FRONTEND_URL,
  'https://carlin5.netlify.app',
  'https://poffbank.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, true); // permissive for now; tighten later
  },
}));

// IMPORTANT: keep the raw body for webhook routes so we can verify HMAC.
// We mount raw() ONLY on webhook paths, and json() on everything else,
// to guarantee the buffer isn't consumed before signature verification.
const RAW_BODY_PATHS = new Set([
  '/api/webhook/nowpayments',
  '/api/webhook/bitcart',
  '/api/webhook/transak',
  '/api/webhook/moonpay',
]);
app.use('/api/webhook/nowpayments', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/api/webhook/bitcart',     express.raw({ type: '*/*', limit: '1mb' }));
app.use('/api/webhook/transak',     express.raw({ type: '*/*', limit: '1mb' }));
app.use('/api/webhook/moonpay',     express.raw({ type: '*/*', limit: '1mb' }));
app.use((req, res, next) => {
  if (RAW_BODY_PATHS.has(req.path)) return next();
  return express.json({ limit: '100kb' })(req, res, next);
});
// Serve ONLY the clean public directory. The old /index.html, /checkout.html,
// /dashboard.html, etc. live in ./legacy and are intentionally NOT exposed.
app.use(express.static('public', { extensions: ['html'] }));

// Friendly root → checkout
app.get('/', (_req, res) => res.redirect(302, '/pay.html'));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// In-memory order store (replace with MongoDB for production)
// ---------------------------------------------------------------------------
const orders = new Map(); // orderId -> { ... }

// ---------------------------------------------------------------------------
// NOWPayments client
// ---------------------------------------------------------------------------
const np = axios.create({
  baseURL: NOWPAYMENTS_API_URL,
  headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

async function npStatus() {
  const { data } = await np.get('/status');
  return data;
}

async function npCreateInvoice({ amount, orderId, description, email }) {
  const payload = {
    price_amount: Number(amount),
    price_currency: PRICE_CURRENCY,
    pay_currency: DEFAULT_PAY_CURRENCY,
    order_id: orderId,
    order_description: description || `${COMPANY_NAME} payment ${orderId}`,
    ipn_callback_url: `${BASE_URL}/api/webhook/nowpayments`,
    success_url: `${FRONTEND_URL}/success.html?order_id=${encodeURIComponent(orderId)}`,
    cancel_url: `${FRONTEND_URL}/cancel.html?order_id=${encodeURIComponent(orderId)}`,
    is_fee_paid_by_user: false,
    customer_email: email || undefined,
    // NOTE: NOWPayments invoices don't accept `payout_address` per-request
    // (their API returns "payout_address is not allowed"). To route hosted
    // checkout settlements to our merchant wallet, set it ONCE in the
    // NOWPayments dashboard → Store Settings → Payout Wallets → USDT TRC-20:
    //   ${USDT_TRC20_WALLET}
    // All hosted invoices will then auto-forward there. Direct (TRC-20)
    // payments already go straight to this wallet on-chain.
  };
  const { data } = await np.post('/invoice', payload);
  return data; // { id, invoice_url, order_id, ... }
}

async function npGetPaymentsForOrder(orderId) {
  // List payments filtered by order_id. NOWPayments returns { data: [...] }.
  const { data } = await np.get('/payment/', { params: { orderId, limit: 5 } });
  return data;
}

async function npGetPaymentById(paymentId) {
  const { data } = await np.get(`/payment/${paymentId}`);
  return data;
}

// ---------------------------------------------------------------------------
// TronGrid client — used to verify direct USDT (TRC-20) payments on-chain
// ---------------------------------------------------------------------------
const tron = axios.create({
  baseURL: TRONGRID_API_URL,
  headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {},
  timeout: 20000,
});

// TronGrid's /v1/transactions/{txid}/events returns address fields as HEX
// (with or without the `41` mainnet prefix). Our wallet is configured in
// Base58Check (`T...`). We decode it once at startup and compare on the
// last 40 hex chars (the 20-byte address proper, prefix-agnostic).
const TRON_B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function tronBase58ToHex(addr) {
  const s = String(addr).trim();
  if (/^41[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^0x[0-9a-fA-F]{40,42}$/i.test(s)) return s.replace(/^0x/i, '').toLowerCase();
  let num = 0n;
  for (const ch of s) {
    const v = TRON_B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base58 char in Tron address');
    num = num * 58n + BigInt(v);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  // Tron base58check: 1 prefix byte + 20 address bytes + 4 checksum bytes = 50 hex chars.
  // Strip the 8-char checksum.
  return hex.slice(0, -8).toLowerCase();
}

function tronAddrLast40(addr) {
  const hex = tronBase58ToHex(addr);
  return hex.length >= 40 ? hex.slice(-40) : hex;
}

// Precompute once.
const WALLET_LAST40   = tronAddrLast40(USDT_TRC20_WALLET);
const CONTRACT_LAST40 = tronAddrLast40(USDT_TRC20_CONTRACT);

/**
 * Verify that a Tron tx hash represents a USDT (TRC-20) transfer to our wallet
 * for at least `expectedUsdt` USDT. Returns { ok, amount, status, reason }.
 *
 *   status: 'completed' | 'confirming' | 'failed' | 'unknown'
 */
async function verifyTronUsdtTransfer(txHash, expectedUsdt) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
    return { ok: false, status: 'failed', reason: 'Invalid transaction hash format.' };
  }

  // 1) Confirm the tx exists and succeeded on-chain.
  let txInfo;
  try {
    const { data } = await tron.post('/wallet/gettransactioninfobyid', { value: txHash });
    txInfo = data;
  } catch (e) {
    return { ok: false, status: 'unknown', reason: 'Could not reach Tron network. Try again in a minute.' };
  }
  if (!txInfo || Object.keys(txInfo).length === 0) {
    // Tx not yet visible to a full node — still propagating or invalid.
    return { ok: false, status: 'confirming', reason: 'Transaction not yet visible on-chain. We\'ll keep checking — refresh in a minute.' };
  }
  if (txInfo.receipt && txInfo.receipt.result && txInfo.receipt.result !== 'SUCCESS') {
    return { ok: false, status: 'failed', reason: `On-chain status: ${txInfo.receipt.result}.` };
  }

  // 2) Pull the TRC-20 transfer events for this tx and find ours.
  let events = [];
  try {
    const { data } = await tron.get(`/v1/transactions/${txHash}/events`);
    events = Array.isArray(data?.data) ? data.data : [];
  } catch (e) {
    return { ok: false, status: 'unknown', reason: 'Could not fetch transaction events.' };
  }
  if (!events.length) {
    return { ok: false, status: 'confirming', reason: 'Transfer events not yet indexed. Try again shortly.' };
  }

  for (const ev of events) {
    if (ev.event_name !== 'Transfer') continue;

    // Contract: TronGrid returns this in base58 on this endpoint.
    let evContractLast40;
    try { evContractLast40 = tronAddrLast40(ev.contract_address); } catch { continue; }
    if (evContractLast40 !== CONTRACT_LAST40) continue;

    // Recipient: in event.result it's hex (with or without 41 prefix).
    const toRaw = ev.result?.to || ev.result?._to;
    if (!toRaw) continue;
    let toLast40;
    try { toLast40 = tronAddrLast40(toRaw); } catch { continue; }
    if (toLast40 !== WALLET_LAST40) continue;

    const raw = ev.result?.value || ev.result?._value || '0';
    let usdt;
    try { usdt = Number(BigInt(raw)) / 1e6; } catch { continue; } // USDT has 6 decimals
    if (!Number.isFinite(usdt) || usdt <= 0) continue;

    // Allow a 1% under-payment tolerance for FX/fees, but no more.
    if (usdt + 0.0000001 < expectedUsdt * 0.99) {
      return {
        ok: false, status: 'failed', amount: usdt,
        reason: `Underpayment: received ${usdt.toFixed(2)} USDT, expected ${expectedUsdt.toFixed(2)} USDT.`,
      };
    }
    return { ok: true, status: 'completed', amount: usdt };
  }

  return {
    ok: false, status: 'failed',
    reason: 'No USDT (TRC-20) transfer to our wallet was found in this transaction.',
  };
}

// ---------------------------------------------------------------------------
// Bitcart client (self-hosted, no-KYB invoicing)
// ---------------------------------------------------------------------------
const bitcart = BITCART_ENABLED
  ? axios.create({
      baseURL: `${BITCART_API_URL}/api`,
      headers: { Authorization: `Bearer ${BITCART_API_TOKEN}` },
      timeout: 25000,
    })
  : null;

function bitcartCheckoutUrl(invoiceId) {
  return BITCART_CHECKOUT_URL_TEMPLATE.replace('{id}', encodeURIComponent(invoiceId));
}

async function bitcartCreateInvoice({ amount, orderId, email, description }) {
  if (!bitcart) throw new Error('Bitcart is not configured.');
  const payload = {
    price: Number(amount),
    currency: PRICE_CURRENCY.toUpperCase(),
    store_id: BITCART_STORE_ID,
    order_id: orderId,
    notification_url: `${BASE_URL}/api/webhook/bitcart`,
    redirect_url: `${FRONTEND_URL}/success.html?order_id=${encodeURIComponent(orderId)}`,
    buyer_email: email || undefined,
    products: description ? [{ name: description.slice(0, 120), quantity: 1, price: Number(amount) }] : undefined,
    metadata: { source: COMPANY_NAME, orderId },
  };
  const { data } = await bitcart.post('/invoices', payload);
  return data;
}

// Map Bitcart invoice statuses to our unified order statuses.
function mapBitcartStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'complete':
    case 'completed':
    case 'paid':
    case 'confirmed':
      return 'completed';
    case 'expired':
    case 'invalid':
    case 'failed':
      return 'failed';
    case 'pending':
    case 'processing':
    case 'confirming':
      return 'confirming';
    case 'new':
    default:
      return 'waiting';
  }
}

// ---------------------------------------------------------------------------
// Card on-ramp helpers (Transak / MoonPay)
// ---------------------------------------------------------------------------
function encodeQuery(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.append(k, String(v));
  }
  return u.toString();
}

/**
 * Build the Transak hosted-checkout URL. Customer pays with card; Transak
 * settles USDT (TRC-20) directly to USDT_TRC20_WALLET on-chain.
 *
 * Docs: https://docs.transak.com/docs/query-parameters
 */
function buildTransakUrl({ orderId, amount, email }) {
  const host = TRANSAK_ENVIRONMENT === 'PRODUCTION'
    ? 'https://global.transak.com'
    : 'https://global-stg.transak.com';

  let referrerDomain;
  try { referrerDomain = new URL(FRONTEND_URL).host; } catch { referrerDomain = undefined; }

  const query = encodeQuery({
    apiKey: TRANSAK_API_KEY,
    referrerDomain,
    productsAvailed: 'BUY',
    defaultPaymentMethod: 'credit_debit_card',
    cryptoCurrencyCode: TRANSAK_CRYPTO_CODE,
    network: TRANSAK_NETWORK,
    walletAddress: USDT_TRC20_WALLET,
    disableWalletAddressForm: 'true',
    fiatCurrency: PRICE_CURRENCY.toUpperCase(),
    fiatAmount: Number(amount).toFixed(2),
    email: email || undefined,
    partnerOrderId: orderId,
    partnerCustomerId: orderId,
    redirectURL: `${FRONTEND_URL}/success.html?order_id=${encodeURIComponent(orderId)}`,
    hostURL: FRONTEND_URL,
    themeColor: '102040',
    hideMenu: 'true',
  });

  return `${host}/?${query}`;
}

// Reference: https://docs.transak.com/docs/order-status-references
function mapTransakStatus(s) {
  switch (String(s || '').toUpperCase()) {
    case 'COMPLETED':
      return 'completed';
    case 'EXPIRED':
    case 'FAILED':
    case 'CANCELLED':
    case 'REFUNDED':
      return 'failed';
    case 'PROCESSING':
    case 'PENDING_DELIVERY_FROM_TRANSAK':
    case 'ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK':
    case 'PAYMENT_DONE_MARKED_BY_USER':
    case 'AWAITING_PAYMENT_FROM_USER':
      return 'confirming';
    default:
      return 'waiting';
  }
}

/**
 * Build the MoonPay hosted-checkout URL. Signed when MOONPAY_SECRET_KEY is set
 * (recommended for production; required if "URL signing" is enforced on the
 * MoonPay dashboard).
 *
 * Docs: https://dev.moonpay.com/docs/ramps-sdk-buy-params
 */
function buildMoonpayUrl({ orderId, amount, email }) {
  const host = MOONPAY_ENVIRONMENT === 'production'
    ? 'https://buy.moonpay.com'
    : 'https://buy-sandbox.moonpay.com';

  const query = encodeQuery({
    apiKey: MOONPAY_API_KEY,
    currencyCode: MOONPAY_CURRENCY_CODE,
    walletAddress: USDT_TRC20_WALLET,
    baseCurrencyCode: PRICE_CURRENCY.toLowerCase(),
    baseCurrencyAmount: Number(amount).toFixed(2),
    email: email || undefined,
    externalTransactionId: orderId,
    externalCustomerId: orderId,
    redirectURL: `${FRONTEND_URL}/success.html?order_id=${encodeURIComponent(orderId)}`,
    showWalletAddressForm: 'false',
    colorCode: '#102040',
  });

  const unsigned = `${host}?${query}`;
  if (!MOONPAY_SECRET_KEY) return unsigned;

  const signature = crypto
    .createHmac('sha256', MOONPAY_SECRET_KEY)
    .update(`?${query}`)
    .digest('base64');
  return `${unsigned}&signature=${encodeURIComponent(signature)}`;
}

function mapMoonpayStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'waitingauthorization':
    case 'waitingpayment':
      return 'confirming';
    default:
      return 'waiting';
  }
}

/**
 * Build a public MoonPay consumer-flow URL. No partner API key, no merchant
 * account, no KYB. Customer completes MoonPay's own KYC; USDT TRC-20 settles
 * directly to USDT_TRC20_WALLET on-chain. Status updates are best-effort
 * (we have no webhook to attach), so order remains 'waiting' until the
 * merchant manually verifies receipt on-chain or the customer submits a tx hash.
 */
function buildPublicMoonpayUrl({ orderId, amount, email }) {
  const query = encodeQuery({
    currencyCode: MOONPAY_CURRENCY_CODE,
    walletAddress: USDT_TRC20_WALLET,
    baseCurrencyCode: PRICE_CURRENCY.toLowerCase(),
    baseCurrencyAmount: Number(amount).toFixed(2),
    email: email || undefined,
    externalTransactionId: orderId,
    redirectURL: `${FRONTEND_URL}/success.html?order_id=${encodeURIComponent(orderId)}`,
    showWalletAddressForm: 'false',
    colorCode: '#102040',
  });
  return `https://buy.moonpay.com/?${query}`;
}

/**
 * Build a ChangeNOW public buy-with-card URL. ChangeNOW is an aggregator that
 * matches the customer to whichever sub-processor (Mercuryo, Simplex, Wert,
 * Banxa, MoonPay) is supported in their country at checkout time. No partner
 * API key needed. The buy widget loads on /buy/tether-trc20 with the wallet
 * address and base-fiat amount preset as query params.
 *
 * Status updates are best-effort (no webhook to attach), so the order stays
 * 'waiting' on our side until the merchant confirms receipt on-chain.
 */
function buildChangeNowUrl({ orderId, amount, email }) {
  const query = encodeQuery({
    amount: Number(amount).toFixed(2),
    fiat: PRICE_CURRENCY.toLowerCase(),
    wallet: USDT_TRC20_WALLET,
    email: email || undefined,
    referralId: orderId,
  });
  return `https://changenow.io/buy/tether-trc20?${query}`;
}

/**
 * Build a Guardarian public buy URL. Guardarian routes primarily through
 * Mercuryo and supports 190+ countries including most African nations
 * (Uganda, Kenya, Nigeria, Ghana, etc.). No partner API key needed.
 */
function buildGuardarianUrl({ orderId, amount, email }) {
  const query = encodeQuery({
    type: 'buy',
    currency_from: PRICE_CURRENCY.toUpperCase(),
    currency_to: 'USDTRC20',
    amount_from: Number(amount).toFixed(2),
    payout_address: USDT_TRC20_WALLET,
    email: email || undefined,
    partner_order_id: orderId,
  });
  return `https://guardarian.com/?${query}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  try {
    const s = await npStatus();
    res.json({ status: 'OK', service: `${COMPANY_NAME} Payment Gateway`, upstream: s });
  } catch (e) {
    res.status(503).json({ status: 'DEGRADED', error: e.message });
  }
});

/**
 * Public config — tells the frontend which payment methods + coins are wired up.
 * Safe to expose: contains no API keys or secrets.
 */
app.get('/api/config', (_req, res) => {
  const wallets = {};
  for (const [k, v] of Object.entries(PAYOUT_WALLETS)) {
    if (v) wallets[k] = v;
  }
  res.json({
    company: COMPANY_NAME,
    priceCurrency: PRICE_CURRENCY.toUpperCase(),
    methods: {
      hosted: true,                                  // NOWPayments (crypto hosted invoice)
      direct: Boolean(PAYOUT_WALLETS.USDTTRC20),     // On-chain USDT TRC-20 self-send
      bitcart: BITCART_ENABLED,                      // Self-hosted Bitcart
      card: CARD_ONRAMP_ENABLED,                     // Card → USDT via Transak/MoonPay
    },
    wallets,
    bitcart: BITCART_ENABLED ? {
      checkoutUrlTemplate: BITCART_CHECKOUT_URL_TEMPLATE,
    } : null,
    card: CARD_ONRAMP_ENABLED ? {
      provider: CARD_ONRAMP_DEFAULT_PROVIDER,
      providers: {
        transak: TRANSAK_ENABLED ? { environment: TRANSAK_ENVIRONMENT.toLowerCase(), kybRequired: true } : null,
        moonpay: MOONPAY_ENABLED ? { environment: MOONPAY_ENVIRONMENT, kybRequired: true } : null,
        'nowpayments-card': CARD_ONRAMP_NOWPAYMENTS_FALLBACK ? { kybRequired: false } : null,
        changenow: CARD_ONRAMP_CHANGENOW ? { kybRequired: false, aggregator: true, regions: 'global' } : null,
        guardarian: CARD_ONRAMP_GUARDARIAN ? { kybRequired: false, aggregator: true, regions: 'global' } : null,
        'moonpay-public': CARD_ONRAMP_MOONPAY_PUBLIC ? { kybRequired: false, regions: 'limited' } : null,
      },
      settles: 'USDT TRC-20',
    } : null,
  });
});

/**
 * Create a hosted crypto invoice.
 * Body: { amount: number, email?: string, description?: string }
 * Returns: { orderId, invoiceUrl }
 */
app.post('/api/invoice', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const email = (req.body?.email || '').toString().trim() || undefined;
    const description = (req.body?.description || '').toString().slice(0, 200) || undefined;

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: 'Minimum amount is 1.00 USD.' });
    }
    if (amount > 1_000_000) {
      return res.status(400).json({ success: false, error: 'Amount too large.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email.' });
    }

    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const invoice = await npCreateInvoice({ amount, orderId, email, description });

    const order = {
      orderId,
      method: 'hosted',
      amount,
      currency: PRICE_CURRENCY.toUpperCase(),
      payCurrency: DEFAULT_PAY_CURRENCY.toUpperCase(),
      email,
      description,
      invoiceId: invoice.id,
      invoiceUrl: invoice.invoice_url,
      status: 'waiting',
      createdAt: new Date().toISOString(),
      payments: [], // populated by IPN
    };
    orders.set(orderId, order);

    console.log(`[${COMPANY_NAME}] Invoice created ${orderId} → ${invoice.invoice_url}`);

    res.json({
      success: true,
      orderId,
      amount,
      currency: order.currency,
      invoiceUrl: invoice.invoice_url,
    });
  } catch (err) {
    const upstream = err.response?.data;
    console.error('[invoice] error:', upstream || err.message);
    res.status(502).json({
      success: false,
      error: 'Could not create invoice. Please try again.',
      detail: upstream?.message || undefined,
    });
  }
});

/**
 * Create a "direct-to-wallet" order. The customer sends USDT (TRC-20) to our
 * merchant wallet themselves, then submits the tx hash for on-chain verification.
 *
 * Body: { amount: number, email?: string, description?: string }
 * Returns: { orderId, amount, wallet, network, contract, tronUri }
 */
app.post('/api/direct-invoice', (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const email = (req.body?.email || '').toString().trim() || undefined;
    const description = (req.body?.description || '').toString().slice(0, 200) || undefined;

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: 'Minimum amount is 1.00 USD.' });
    }
    if (amount > 1_000_000) {
      return res.status(400).json({ success: false, error: 'Amount too large.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email.' });
    }

    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const order = {
      orderId,
      method: 'direct',
      amount,
      currency: PRICE_CURRENCY.toUpperCase(),
      payCurrency: 'USDTTRC20',
      email,
      description,
      wallet: USDT_TRC20_WALLET,
      network: 'TRC20',
      contract: USDT_TRC20_CONTRACT,
      status: 'waiting',
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);

    // tron: URI scheme so QR-aware wallets can prefill. Many wallets ignore
    // amount/contract params and fall back to the address alone — that's fine.
    const tronUri = `tron:${USDT_TRC20_WALLET}?token=${USDT_TRC20_CONTRACT}&amount=${amount}`;

    console.log(`[${COMPANY_NAME}] Direct order created ${orderId} for ${amount} USDT`);

    res.json({
      success: true,
      orderId,
      amount,
      currency: order.currency,
      wallet: USDT_TRC20_WALLET,
      network: 'TRC20',
      contract: USDT_TRC20_CONTRACT,
      tronUri,
    });
  } catch (err) {
    console.error('[direct-invoice] error:', err.message);
    res.status(500).json({ success: false, error: 'Could not create order. Please try again.' });
  }
});

/**
 * Customer submits the tx hash they paid with. We verify on-chain via TronGrid
 * and mark the order accordingly.
 *
 * Body: { txHash: string }
 */
app.post('/api/direct-invoice/:orderId/submit-tx', async (req, res) => {
  const { orderId } = req.params;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
  if (order.method !== 'direct') {
    return res.status(400).json({ success: false, error: 'This order does not accept direct tx submission.' });
  }
  if (order.status === 'completed') {
    return res.json({ success: true, status: 'completed', message: 'Already confirmed.' });
  }

  const txHash = String(req.body?.txHash || '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ success: false, error: 'Please paste a valid 64-character Tron transaction hash.' });
  }

  // Prevent the same hash being reused on a different order.
  for (const [oid, o] of orders) {
    if (oid !== orderId && o.txHash && o.txHash.toLowerCase() === txHash.toLowerCase()) {
      return res.status(409).json({ success: false, error: 'This transaction hash has already been used for another order.' });
    }
  }

  order.txHash = txHash;
  order.txSubmittedAt = new Date().toISOString();
  order.status = 'confirming';
  orders.set(orderId, order);

  let result;
  try {
    result = await verifyTronUsdtTransfer(txHash, order.amount);
  } catch (e) {
    console.error('[submit-tx] verification crashed:', e);
    return res.status(502).json({ success: false, error: 'On-chain verification failed. Try again in a minute.' });
  }

  if (result.ok) {
    order.status = 'completed';
    order.usdtReceived = result.amount;
    order.confirmedAt = new Date().toISOString();
    orders.set(orderId, order);
    console.log(`[direct] order ${orderId} CONFIRMED on-chain (${result.amount} USDT, tx ${txHash})`);
    return res.json({ success: true, status: 'completed', amount: result.amount });
  }

  // Not OK but still "confirming" (e.g. tx not yet indexed): leave the order
  // in confirming state so polling will keep going. Otherwise mark failed.
  if (result.status === 'confirming' || result.status === 'unknown') {
    return res.json({
      success: true,
      status: 'confirming',
      message: result.reason || 'Verification pending.',
    });
  }

  order.status = 'failed';
  order.failureReason = result.reason;
  orders.set(orderId, order);
  console.warn(`[direct] order ${orderId} FAILED: ${result.reason}`);
  return res.status(400).json({ success: false, status: 'failed', error: result.reason });
});

/**
 * Card → USDT on-ramp. Builds a hosted-checkout URL on Transak (or MoonPay,
 * if explicitly requested via ?provider=moonpay) with USDT_TRC20_WALLET preset
 * as the destination. The provider charges the customer's card, converts the
 * fiat to USDT, and settles the USDT on-chain directly to our merchant wallet.
 *
 * Body: { amount: number, email?: string, description?: string, provider?: 'transak'|'moonpay' }
 * Returns: { orderId, onrampUrl, provider }
 */
app.post('/api/card-onramp', async (req, res) => {
  try {
    if (!CARD_ONRAMP_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Card payments are not configured on this server yet. Set TRANSAK_API_KEY (or MOONPAY_API_KEY) in the environment.',
      });
    }

    const amount = Number(req.body?.amount);
    const email = (req.body?.email || '').toString().trim() || undefined;
    const description = (req.body?.description || '').toString().slice(0, 200) || undefined;
    const requested = String(req.body?.provider || '').toLowerCase();

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: 'Minimum amount is 1.00 USD.' });
    }
    if (amount > 1_000_000) {
      return res.status(400).json({ success: false, error: 'Amount too large.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email.' });
    }

    let provider = CARD_ONRAMP_DEFAULT_PROVIDER;
    if (requested === 'transak' && TRANSAK_ENABLED) provider = 'transak';
    else if (requested === 'moonpay' && MOONPAY_ENABLED) provider = 'moonpay';
    else if (requested === 'nowpayments-card' && CARD_ONRAMP_NOWPAYMENTS_FALLBACK) provider = 'nowpayments-card';
    else if (requested === 'changenow' && CARD_ONRAMP_CHANGENOW) provider = 'changenow';
    else if (requested === 'guardarian' && CARD_ONRAMP_GUARDARIAN) provider = 'guardarian';
    else if (requested === 'moonpay-public' && CARD_ONRAMP_MOONPAY_PUBLIC) provider = 'moonpay-public';
    else if (requested && requested !== provider) {
      return res.status(400).json({
        success: false,
        error: `Card on-ramp provider "${requested}" is not configured on this server.`,
      });
    }

    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    let onrampUrl;
    let providerEnv;
    let invoiceId;
    if (provider === 'transak') {
      onrampUrl = buildTransakUrl({ orderId, amount, email });
      providerEnv = TRANSAK_ENVIRONMENT.toLowerCase();
    } else if (provider === 'moonpay') {
      onrampUrl = buildMoonpayUrl({ orderId, amount, email });
      providerEnv = MOONPAY_ENVIRONMENT;
    } else if (provider === 'moonpay-public') {
      onrampUrl = buildPublicMoonpayUrl({ orderId, amount, email });
      providerEnv = 'public';
    } else if (provider === 'changenow') {
      onrampUrl = buildChangeNowUrl({ orderId, amount, email });
      providerEnv = 'public';
    } else if (provider === 'guardarian') {
      onrampUrl = buildGuardarianUrl({ orderId, amount, email });
      providerEnv = 'public';
    } else if (provider === 'nowpayments-card') {
      // No-KYB fallback: create a NOWPayments hosted invoice. The customer sees
      // a "Buy with card" button on the hosted page (Simplex/Mercuryo). USDT
      // settles to the wallet configured in the merchant's NOWPayments dashboard.
      const invoice = await npCreateInvoice({
        amount,
        orderId,
        email,
        description: description ? `${description} (card)` : `Card payment ${orderId}`,
      });
      onrampUrl = invoice.invoice_url;
      invoiceId = invoice.id;
      providerEnv = 'live';
    }
    if (!onrampUrl) {
      return res.status(503).json({ success: false, error: 'Card on-ramp is not available right now.' });
    }

    const order = {
      orderId,
      method: 'card',
      provider,
      providerEnv,
      amount,
      currency: PRICE_CURRENCY.toUpperCase(),
      payCurrency: 'USDTTRC20',
      email,
      description,
      wallet: USDT_TRC20_WALLET,
      network: 'TRC20',
      contract: USDT_TRC20_CONTRACT,
      onrampUrl,
      invoiceId,
      // For NOWPayments fallback, status will be updated by /api/webhook/nowpayments
      // (which already handles the IPN signed payload). For moonpay-public, no
      // webhook is possible — the order stays 'waiting' and the customer is
      // expected to land back on /success.html for receipt.
      status: 'waiting',
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);

    console.log(`[${COMPANY_NAME}] Card on-ramp order created ${orderId} via ${provider} (${providerEnv}) for ${amount} ${order.currency}`);

    res.json({
      success: true,
      orderId,
      provider,
      providerEnv,
      amount,
      currency: order.currency,
      onrampUrl,
      settlement: { wallet: USDT_TRC20_WALLET, network: 'TRC20', asset: 'USDT' },
    });
  } catch (err) {
    const upstream = err.response?.data;
    console.error('[card-onramp] error:', upstream || err.message);
    res.status(502).json({
      success: false,
      error: 'Could not create card on-ramp session. Please try again.',
      detail: typeof upstream === 'string' ? upstream : upstream?.message || undefined,
    });
  }
});

/**
 * Transak webhook (Order Processor v2).
 * Configure in Transak dashboard → Webhooks → URL:
 *   {BASE_URL}/api/webhook/transak
 *
 * Signature: Transak signs the JWT-encoded payload with the partner's API
 * secret (TRANSAK_WEBHOOK_SECRET). The body is `{ data: "<jwt>" }`.
 * We verify the HMAC-SHA256 of the JWT signing input against the third
 * segment to ensure authenticity, then decode the payload.
 */
app.post('/api/webhook/transak', (req, res) => {
  try {
    if (!TRANSAK_ENABLED || !TRANSAK_WEBHOOK_SECRET) {
      console.warn('[transak-webhook] rejected: not configured');
      return res.status(400).json({ ok: false });
    }
    const raw = req.body; // Buffer (express.raw)
    if (!raw?.length) return res.status(400).json({ ok: false, error: 'empty body' });

    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ ok: false, error: 'invalid json' }); }

    // Transak wraps the payload as a JWS: `{ data: "<header>.<payload>.<sig>" }`.
    // Older builds sent the order JSON directly with an X-Webhook-Signature header.
    let order, eventID;
    if (typeof parsed.data === 'string' && parsed.data.split('.').length === 3) {
      const [h, p, s] = parsed.data.split('.');
      const expected = crypto
        .createHmac('sha256', TRANSAK_WEBHOOK_SECRET)
        .update(`${h}.${p}`)
        .digest('base64')
        .replace(/=+$/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      if (expected !== s) {
        console.warn('[transak-webhook] JWT signature mismatch');
        return res.status(401).json({ ok: false });
      }
      try {
        const decoded = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        order = decoded.webhookData || decoded.data || decoded;
        eventID = decoded.eventID || decoded.event || decoded.status;
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid jwt payload' });
      }
    } else {
      // Legacy header-based signature (HMAC-SHA256 of raw body).
      const sig = (req.header('x-webhook-signature') || req.header('x-transak-signature') || '').toLowerCase();
      const expected = crypto.createHmac('sha256', TRANSAK_WEBHOOK_SECRET).update(raw).digest('hex');
      const sigHex = sig.replace(/^sha256=/i, '');
      const ok = sigHex.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'));
      if (!ok) {
        console.warn('[transak-webhook] header signature mismatch');
        return res.status(401).json({ ok: false });
      }
      order = parsed.webhookData || parsed.data || parsed;
      eventID = parsed.eventID || parsed.event || order?.status;
    }

    const orderId = order?.partnerOrderId || order?.partnerCustomerId;
    if (!orderId) {
      console.warn('[transak-webhook] no partnerOrderId in payload');
      return res.json({ ok: true });
    }
    const ours = orders.get(orderId);
    if (!ours) {
      console.warn(`[transak-webhook] unknown order ${orderId}`);
      return res.json({ ok: true });
    }

    ours.status = mapTransakStatus(order.status || eventID);
    ours.providerOrderId = order.id || ours.providerOrderId;
    ours.txHash = order.transactionHash || order.cryptoTransactionHash || ours.txHash;
    ours.usdtReceived = order.cryptoAmount || ours.usdtReceived;
    ours.amountReceived = order.fiatAmount || ours.amountReceived;
    ours.payCurrency = (order.cryptoCurrency || ours.payCurrency || '').toString().toUpperCase();
    ours.updatedAt = new Date().toISOString();
    orders.set(orderId, ours);

    console.log(`[transak-webhook] order ${orderId} → ${ours.status} (${eventID || order.status})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[transak-webhook] error:', e);
    res.status(200).json({ ok: true }); // never make Transak retry on our bug
  }
});

/**
 * MoonPay webhook. Signature header: `Moonpay-Signature-V2: t=<ts>,s=<sig>`.
 * Sig = HMAC-SHA256(`${t}.${rawBody}`, MOONPAY_SECRET_KEY) hex-encoded.
 */
app.post('/api/webhook/moonpay', (req, res) => {
  try {
    if (!MOONPAY_ENABLED || !MOONPAY_SECRET_KEY) {
      console.warn('[moonpay-webhook] rejected: not configured');
      return res.status(400).json({ ok: false });
    }
    const raw = req.body;
    if (!raw?.length) return res.status(400).json({ ok: false, error: 'empty body' });

    const header = req.header('moonpay-signature-v2') || req.header('moonpay-signature') || '';
    const parts = Object.fromEntries(header.split(',').map(p => p.split('=').map(x => x.trim())));
    const t = parts.t;
    const s = (parts.s || '').toLowerCase();
    if (!t || !s) {
      console.warn('[moonpay-webhook] missing signature header');
      return res.status(401).json({ ok: false });
    }
    const expected = crypto.createHmac('sha256', MOONPAY_SECRET_KEY)
      .update(`${t}.${raw.toString('utf8')}`)
      .digest('hex');
    const ok = expected.length === s.length &&
      crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex'));
    if (!ok) {
      console.warn('[moonpay-webhook] signature mismatch');
      return res.status(401).json({ ok: false });
    }

    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ ok: false, error: 'invalid json' }); }

    const data = parsed.data || parsed;
    const orderId = data.externalTransactionId || data.externalCustomerId;
    if (!orderId) {
      console.warn('[moonpay-webhook] no externalTransactionId');
      return res.json({ ok: true });
    }
    const ours = orders.get(orderId);
    if (!ours) return res.json({ ok: true });

    ours.status = mapMoonpayStatus(data.status);
    ours.providerOrderId = data.id || ours.providerOrderId;
    ours.txHash = data.cryptoTransactionId || ours.txHash;
    ours.usdtReceived = data.quoteCurrencyAmount || ours.usdtReceived;
    ours.amountReceived = data.baseCurrencyAmount || ours.amountReceived;
    ours.updatedAt = new Date().toISOString();
    orders.set(orderId, ours);

    console.log(`[moonpay-webhook] order ${orderId} → ${ours.status} (${data.status})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[moonpay-webhook] error:', e);
    res.status(200).json({ ok: true });
  }
});

/**
 * Create a Bitcart (self-hosted) invoice. Same shape as /api/invoice.
 * Returns: { orderId, invoiceUrl }
 */
app.post('/api/bitcart-invoice', async (req, res) => {
  if (!BITCART_ENABLED) {
    return res.status(503).json({ success: false, error: 'Self-hosted Bitcart is not configured on this server.' });
  }
  try {
    const amount = Number(req.body?.amount);
    const email = (req.body?.email || '').toString().trim() || undefined;
    const description = (req.body?.description || '').toString().slice(0, 200) || undefined;

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: 'Minimum amount is 1.00.' });
    }
    if (amount > 1_000_000) {
      return res.status(400).json({ success: false, error: 'Amount too large.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email.' });
    }

    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const invoice = await bitcartCreateInvoice({ amount, orderId, email, description });

    const invoiceId = invoice.id || invoice.invoice_id;
    if (!invoiceId) throw new Error('Bitcart did not return an invoice id.');
    // Newer Bitcart returns `checkout_url` directly. Fall back to template.
    const invoiceUrl = invoice.checkout_url || invoice.payment_url || bitcartCheckoutUrl(invoiceId);

    const order = {
      orderId,
      method: 'bitcart',
      amount,
      currency: PRICE_CURRENCY.toUpperCase(),
      email,
      description,
      bitcartInvoiceId: invoiceId,
      invoiceUrl,
      status: 'waiting',
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);

    console.log(`[${COMPANY_NAME}] Bitcart invoice created ${orderId} → ${invoiceUrl}`);

    res.json({
      success: true,
      orderId,
      amount,
      currency: order.currency,
      invoiceUrl,
    });
  } catch (err) {
    const upstream = err.response?.data;
    console.error('[bitcart-invoice] error:', upstream || err.message);
    res.status(502).json({
      success: false,
      error: 'Could not create Bitcart invoice. Please try again.',
      detail: typeof upstream === 'string' ? upstream : upstream?.detail || upstream?.message || undefined,
    });
  }
});

/**
 * Bitcart webhook. Configure in Bitcart admin → Store → Webhooks:
 *   URL:    {BASE_URL}/api/webhook/bitcart
 *   Secret: BITCART_WEBHOOK_SECRET
 * Bitcart sends an HMAC-SHA256 over the raw request body in `X-Bitcart-Sig`
 * (older builds) or `Bitcart-Sig` / `bitcart-signature` headers. We accept any.
 */
app.post('/api/webhook/bitcart', async (req, res) => {
  try {
    if (!BITCART_ENABLED || !BITCART_WEBHOOK_SECRET) {
      console.warn('[bitcart-webhook] rejected: not configured');
      return res.status(400).json({ ok: false });
    }
    const raw = req.body; // Buffer (express.raw)
    if (!raw?.length) return res.status(400).json({ ok: false, error: 'empty body' });

    // Bitcart >= ~0.7 sends `X-Signature`. Older builds used `bitcart-sig`.
    // Accept any of the historical headers so this works across versions.
    const sig = req.header('x-signature')
      || req.header('x-bitcart-sig')
      || req.header('bitcart-sig')
      || req.header('bitcart-signature')
      || '';
    const expected = crypto.createHmac('sha256', BITCART_WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');

    const sigHex = sig.replace(/^sha256=/i, '').toLowerCase();
    const ok = sigHex.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'));
    if (!ok) {
      console.warn('[bitcart-webhook] signature mismatch');
      return res.status(401).json({ ok: false });
    }

    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ ok: false, error: 'invalid json' }); }

    // Bitcart sends { event: 'invoice_paid', data: { id, status, order_id, paid_currency, payments: [...] } }
    // or sometimes a flat invoice payload — handle both.
    const data = parsed.data || parsed;
    const evt = parsed.event || data.event || data.status;
    const orderId = data.order_id || data.metadata?.orderId;
    if (!orderId) {
      console.warn('[bitcart-webhook] no order_id in payload');
      return res.json({ ok: true });
    }

    const order = orders.get(orderId);
    if (!order) {
      console.warn(`[bitcart-webhook] unknown order ${orderId}`);
      return res.json({ ok: true });
    }

    order.status = mapBitcartStatus(data.status || evt);
    order.bitcartInvoiceId = data.id || order.bitcartInvoiceId;
    order.payCurrency = (data.paid_currency || data.currency || order.payCurrency || '').toString().toUpperCase();
    if (Array.isArray(data.payments) && data.payments[0]) {
      order.txHash = data.payments[0].tx_hash || data.payments[0].txid || order.txHash;
      order.amountReceived = data.payments[0].amount || order.amountReceived;
    }
    order.updatedAt = new Date().toISOString();
    orders.set(orderId, order);

    console.log(`[bitcart-webhook] order ${orderId} → ${order.status} (${evt || data.status})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bitcart-webhook] error:', e);
    res.status(200).json({ ok: true }); // never make Bitcart retry on our bug
  }
});

/**
 * Get status of an order. Falls back to NOWPayments if we haven't received an IPN yet.
 */
app.get('/api/payment/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

  // If not finalised, ask NOWPayments directly for any order that has an
  // invoiceId. This covers both 'hosted' orders and 'card' orders routed
  // through the no-KYB NOWPayments fallback. Direct-to-wallet orders have
  // no invoiceId and shouldn't be polled there.
  const FINAL = new Set(['completed', 'failed']);
  if (!FINAL.has(order.status) && (order.method === 'hosted' || order.method === 'card') && order.invoiceId) {
    try {
      let latest = null;
      if (order.lastPaymentId) {
        latest = await npGetPaymentById(order.lastPaymentId);
      } else {
        const list = await npGetPaymentsForOrder(orderId);
        latest = Array.isArray(list?.data) ? list.data[0] : null;
      }
      if (latest && latest.payment_status) {
        order.lastPaymentId = latest.payment_id || order.lastPaymentId;
        order.status = mapNpStatus(latest.payment_status);
        order.txHash = latest.payin_hash || latest.outcome?.hash || order.txHash;
        order.amountReceived = latest.actually_paid || order.amountReceived;
        order.usdtReceived = latest.outcome?.amount || latest.outcome_amount || order.usdtReceived;
        orders.set(orderId, order);
      }
    } catch (e) {
      console.warn('[status] upstream lookup failed:', e.message);
    }
  }

  // Same idea for Bitcart orders.
  if (!FINAL.has(order.status) && order.method === 'bitcart' && order.bitcartInvoiceId && bitcart) {
    try {
      const { data } = await bitcart.get(`/invoices/${encodeURIComponent(order.bitcartInvoiceId)}`);
      if (data) {
        order.status = mapBitcartStatus(data.status);
        if (Array.isArray(data.payments) && data.payments[0]) {
          order.txHash = data.payments[0].tx_hash || data.payments[0].txid || order.txHash;
          order.amountReceived = data.payments[0].amount || order.amountReceived;
        }
        order.payCurrency = (data.paid_currency || order.payCurrency || '').toString().toUpperCase();
        orders.set(orderId, order);
      }
    } catch (e) {
      console.warn('[status] bitcart lookup failed:', e.message);
    }
  }

  res.json({
    success: true,
    orderId,
    method: order.method || 'hosted',
    provider: order.provider,
    status: order.status,
    amount: order.amount,
    currency: order.currency,
    payCurrency: order.payCurrency,
    amountReceived: order.amountReceived,
    usdtReceived: order.usdtReceived,
    txHash: order.txHash,
    invoiceUrl: order.invoiceUrl,
    onrampUrl: order.onrampUrl,
    wallet: order.wallet,
    network: order.network,
    failureReason: order.failureReason,
    createdAt: order.createdAt,
  });
});

/**
 * NOWPayments IPN.
 * https://documenter.getpostman.com/view/7907941/S1a32n38#28d3df1a-f9d6-4d3d-a9d2-30d2c7b2c8e8
 *
 * Signature header: x-nowpayments-sig
 * Payload: sorted-keys JSON string, HMAC-SHA512 with IPN secret.
 */
app.post('/api/webhook/nowpayments', (req, res) => {
  try {
    const sig = req.header('x-nowpayments-sig');
    const raw = req.body; // Buffer (express.raw)
    if (!sig || !NOWPAYMENTS_IPN_SECRET || !raw?.length) {
      console.warn('[webhook] rejected: missing sig/secret/body');
      return res.status(400).json({ ok: false });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid json' });
    }

    const sortedJson = JSON.stringify(parsed, Object.keys(parsed).sort());
    const expected = crypto
      .createHmac('sha512', NOWPAYMENTS_IPN_SECRET)
      .update(sortedJson)
      .digest('hex');

    const ok = sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) {
      console.warn('[webhook] signature mismatch');
      return res.status(401).json({ ok: false });
    }

    const {
      payment_id,
      payment_status,
      order_id,
      pay_amount,
      actually_paid,
      outcome_amount,
      pay_currency,
      outcome_currency,
      payin_hash,
    } = parsed;

    const order = orders.get(order_id);
    if (!order) {
      console.warn(`[webhook] unknown order ${order_id}`);
      return res.json({ ok: true }); // ack so NP doesn't retry forever
    }

    order.status = mapNpStatus(payment_status);
    order.amountReceived = actually_paid || pay_amount || order.amountReceived;
    order.usdtReceived = outcome_amount || order.usdtReceived;
    order.payCurrency = (pay_currency || order.payCurrency || '').toUpperCase();
    order.outcomeCurrency = (outcome_currency || order.outcomeCurrency || '').toUpperCase();
    order.txHash = payin_hash || order.txHash;
    order.lastPaymentId = payment_id;
    order.updatedAt = new Date().toISOString();
    orders.set(order_id, order);

    console.log(`[webhook] order ${order_id} → ${order.status} (${payment_status})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e);
    res.status(200).json({ ok: true }); // never make NP retry on our bug
  }
});

function mapNpStatus(s) {
  switch (s) {
    case 'finished':
    case 'confirmed':
      return 'completed';
    case 'partially_paid':
      return 'partially_paid';
    case 'failed':
    case 'expired':
    case 'refunded':
      return 'failed';
    case 'sending':
    case 'confirming':
      return 'confirming';
    case 'waiting':
    default:
      return 'waiting';
  }
}

// Friendly redirects
app.get('/payment/success', (req, res) => {
  res.redirect(`/success.html?order_id=${encodeURIComponent(req.query.order_id || '')}`);
});
app.get('/payment/cancel', (req, res) => {
  res.redirect(`/cancel.html?order_id=${encodeURIComponent(req.query.order_id || '')}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n${COMPANY_NAME}`);
  console.log(`  Port:           ${PORT}`);
  console.log(`  Base URL:       ${BASE_URL}`);
  console.log(`  Pay currency:   ${DEFAULT_PAY_CURRENCY}`);
  console.log(`  IPN endpoint:   ${BASE_URL}/api/webhook/nowpayments`);
  console.log(`  Checkout page:  ${FRONTEND_URL}/pay.html`);
  console.log(`  Direct wallet:  ${USDT_TRC20_WALLET} (TRC-20)`);
  console.log(`  TronGrid key:   ${TRONGRID_API_KEY ? 'set' : 'unauthenticated (rate-limited)'}`);
  console.log(`  IPN secret:     ${NOWPAYMENTS_IPN_SECRET ? 'set' : 'MISSING'}`);
  console.log(`  Bitcart:        ${BITCART_ENABLED ? `enabled (${BITCART_API_URL})` : 'disabled (set BITCART_API_URL, BITCART_API_TOKEN, BITCART_STORE_ID, BITCART_WEBHOOK_SECRET to enable)'}`);
  if (CARD_ONRAMP_ENABLED) {
    const providers = [];
    if (TRANSAK_ENABLED) providers.push(`transak:${TRANSAK_ENVIRONMENT.toLowerCase()}`);
    if (MOONPAY_ENABLED) providers.push(`moonpay:${MOONPAY_ENVIRONMENT}`);
    if (CARD_ONRAMP_NOWPAYMENTS_FALLBACK) providers.push('nowpayments-card (no-KYB)');
    if (CARD_ONRAMP_CHANGENOW) providers.push('changenow (no-KYB, global)');
    if (CARD_ONRAMP_GUARDARIAN) providers.push('guardarian (no-KYB, global)');
    if (CARD_ONRAMP_MOONPAY_PUBLIC) providers.push('moonpay-public (no-KYB)');
    console.log(`  Card on-ramp:   enabled → ${providers.join(', ')}`);
    console.log(`  Default route:  ${CARD_ONRAMP_DEFAULT_PROVIDER}`);
    console.log(`  Card endpoint:  POST ${BASE_URL}/api/card-onramp  →  ${USDT_TRC20_WALLET} (TRC-20)`);
    if (TRANSAK_ENABLED) {
      console.log(`  Transak webhook:${BASE_URL}/api/webhook/transak ${TRANSAK_WEBHOOK_SECRET ? '(secret set)' : '(MISSING TRANSAK_WEBHOOK_SECRET)'}`);
    }
    if (MOONPAY_ENABLED) {
      console.log(`  MoonPay webhook:${BASE_URL}/api/webhook/moonpay ${MOONPAY_SECRET_KEY ? '(secret set)' : '(MISSING MOONPAY_SECRET_KEY)'}`);
    }
  } else {
    console.log(`  Card on-ramp:   disabled`);
  }
  const wiredCoins = Object.entries(PAYOUT_WALLETS).filter(([, v]) => v).map(([k]) => k).join(', ');
  console.log(`  Coins wired:    ${wiredCoins || '(none)'}\n`);
});

module.exports = app;
