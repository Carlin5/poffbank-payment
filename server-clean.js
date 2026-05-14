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

if (!NOWPAYMENTS_API_KEY) {
  console.error('[FATAL] NOWPAYMENTS_API_KEY is not set in environment.');
  process.exit(1);
}
if (!NOWPAYMENTS_IPN_SECRET) {
  console.warn('[WARN] NOWPAYMENTS_IPN_SECRET is not set — webhook signatures will be rejected.');
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

// IMPORTANT: keep the raw body for the webhook route so we can verify HMAC.
// We mount raw() ONLY on the webhook path, and json() on everything else,
// to guarantee the buffer isn't consumed before signature verification.
app.use('/api/webhook/nowpayments', express.raw({ type: '*/*', limit: '1mb' }));
app.use((req, res, next) => {
  if (req.path === '/api/webhook/nowpayments') return next();
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
      amount,
      currency: PRICE_CURRENCY.toUpperCase(),
      payCurrency: DEFAULT_PAY_CURRENCY.toUpperCase(),
      email,
      description,
      invoiceId: invoice.id,
      invoiceUrl: invoice.invoice_url,
      status: 'pending',
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
 * Get status of an order. Falls back to NOWPayments if we haven't received an IPN yet.
 */
app.get('/api/payment/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

  // If not finalised, ask NOWPayments directly (in case IPN was missed).
  const FINAL = new Set(['completed', 'failed']);
  if (!FINAL.has(order.status)) {
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

  res.json({
    success: true,
    orderId,
    status: order.status,
    amount: order.amount,
    currency: order.currency,
    payCurrency: order.payCurrency,
    amountReceived: order.amountReceived,
    usdtReceived: order.usdtReceived,
    txHash: order.txHash,
    invoiceUrl: order.invoiceUrl,
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
  console.log(`  IPN secret:     ${NOWPAYMENTS_IPN_SECRET ? 'set' : 'MISSING'}\n`);
});

module.exports = app;
