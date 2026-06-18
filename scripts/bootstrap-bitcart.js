/**
 * One-shot Bitcart provisioning script.
 * --------------------------------------
 * Stands up the wallet, store, and signed webhook in your self-hosted
 * Bitcart instance so the PoffBank gateway can route invoices through it.
 *
 * Usage:
 *   1. Stand up Bitcart per BITCART_SETUP.md (sections 1-2).
 *   2. In Bitcart admin → Manage Tokens, create a token with the
 *      "server_management" permission. Copy it.
 *   3. Set the env vars below (in .env or inline) and run:
 *
 *        BITCART_API_URL=https://admin.pay.your-domain.com \
 *        BITCART_BOOTSTRAP_TOKEN=<paste token> \
 *        BITCART_WEBHOOK_SECRET=$(openssl rand -hex 32) \
 *        BASE_URL=https://poffbank-api.onrender.com \
 *        node scripts/bootstrap-bitcart.js
 *
 *   4. Copy the printed BITCART_STORE_ID + BITCART_WEBHOOK_SECRET into
 *      your Render env, plus BITCART_API_TOKEN (same token you just used).
 *
 * Idempotent: re-running won't duplicate wallets or webhooks. It looks up
 * existing entries by name and reuses them.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const API_URL = (process.env.BITCART_API_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.BITCART_BOOTSTRAP_TOKEN || process.env.BITCART_API_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.BITCART_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// Wallets to provision. The USDT TRC-20 destination is the merchant payout
// wallet — same address used by the direct-payment flow, so all three
// payment methods land in the same place.
const WALLETS = [
  {
    name: 'PoffBank USDT TRC-20',
    currency: 'TRX', // Tron daemon handles TRC-20 USDT under the TRX wallet
    xpub: process.env.USDT_TRC20_WALLET || 'TPznWCtmn4WLuubNDTZ92e1gSiuYF9nqj6',
    contract: process.env.USDT_TRC20_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    label: 'usdt-trc20',
  },
  // Optional extras — only added if a wallet env is set.
  process.env.BTC_WALLET && {
    name: 'PoffBank BTC',
    currency: 'BTC',
    xpub: process.env.BTC_WALLET,
    label: 'btc',
  },
  process.env.ETH_WALLET && {
    name: 'PoffBank ETH',
    currency: 'ETH',
    xpub: process.env.ETH_WALLET,
    label: 'eth',
  },
  process.env.USDT_POLYGON_WALLET && {
    name: 'PoffBank USDT Polygon',
    currency: 'MATIC',
    xpub: process.env.USDT_POLYGON_WALLET,
    label: 'usdt-polygon',
    // Polygon USDT contract on Polygon mainnet:
    contract: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  },
].filter(Boolean);

const STORE_NAME = process.env.BITCART_STORE_NAME || 'PoffBank';
const WEBHOOK_URL = `${BASE_URL.replace(/\/+$/, '')}/api/webhook/bitcart`;

if (!API_URL || !TOKEN) {
  console.error('Missing env. Required: BITCART_API_URL, BITCART_BOOTSTRAP_TOKEN (or BITCART_API_TOKEN).');
  process.exit(1);
}

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { Authorization: `Bearer ${TOKEN}` },
  timeout: 30000,
});

// Some Bitcart endpoints return paginated { count, result } and others return
// a flat array. Normalise.
function asList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

async function findOrCreate(path, matcher, payload) {
  const list = asList((await api.get(path, { params: { limit: 200 } })).data);
  const existing = list.find(matcher);
  if (existing) return { entity: existing, created: false };
  const { data } = await api.post(path, payload);
  return { entity: data, created: true };
}

(async () => {
  console.log('Bitcart bootstrap');
  console.log('  API URL:    ', API_URL);
  console.log('  Webhook URL:', WEBHOOK_URL);
  console.log('  Wallets:    ', WALLETS.map(w => w.name).join(', '));
  console.log('');

  // 1. Wallets
  const walletIds = [];
  for (const w of WALLETS) {
    try {
      const { entity, created } = await findOrCreate(
        '/wallets',
        x => x.name === w.name || (x.xpub === w.xpub && (x.currency || '').toLowerCase() === w.currency.toLowerCase()),
        {
          name: w.name,
          currency: w.currency,
          xpub: w.xpub,
          // Bitcart accepts `contract` for token-aware wallets on TRX / ETH / MATIC.
          contract: w.contract,
          additional_xpub_data: { contract: w.contract },
          label: w.label,
        }
      );
      walletIds.push(entity.id);
      console.log(`  ${created ? 'Created' : 'Reused '} wallet ${entity.id}  ${w.name}`);
    } catch (e) {
      const msg = e.response?.data?.detail || e.response?.data || e.message;
      console.error(`  FAILED to provision ${w.name}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      console.error('  Continuing with other wallets…');
    }
  }
  if (!walletIds.length) {
    console.error('No wallets were provisioned. Check the daemon is running for the requested coin.');
    process.exit(2);
  }

  // 2. Store
  const { entity: store, created: storeCreated } = await findOrCreate(
    '/stores',
    x => x.name === STORE_NAME,
    {
      name: STORE_NAME,
      default_currency: 'USD',
      wallets: walletIds,
      checkout_settings: {
        expiration: 60,
        transaction_speed: 0,
        underpaid_percentage: 1,
        custom_logo_link: '',
        recommended_fee_target_blocks: 1,
        show_recommended_fee: false,
        use_dark_mode: false,
        use_html_templates: false,
        email_required: false,
        ask_address: false,
        randomize_wallet_selection: false,
        allow_anonymous_invoice_creation: true,
      },
    }
  );
  console.log(`  ${storeCreated ? 'Created' : 'Reused '} store  ${store.id}  ${STORE_NAME}`);

  // Make sure the store has all the wallets we just (re)provisioned.
  const currentWalletIds = new Set((store.wallets || []).map(w => (typeof w === 'object' ? w.id : w)));
  const missing = walletIds.filter(id => !currentWalletIds.has(id));
  if (missing.length) {
    await api.patch(`/stores/${store.id}`, { wallets: [...currentWalletIds, ...missing] });
    console.log(`  Attached ${missing.length} wallet(s) to store`);
  }

  // 3. Webhook (Bitcart calls these "notifications" or "store webhooks" depending on version)
  // Try the modern /notifications endpoint first; fall back to the older
  // store-scoped webhook endpoint.
  const events = [
    'invoice_created', 'invoice_paid', 'invoice_complete',
    'invoice_expired', 'invoice_invalid', 'invoice_failed',
  ];
  let webhook;
  let webhookEndpoint = `/notifications`;
  try {
    const { entity, created } = await findOrCreate(
      webhookEndpoint,
      x => x.url === WEBHOOK_URL || (x.name === `${STORE_NAME} → PoffBank API`),
      {
        name: `${STORE_NAME} → PoffBank API`,
        provider: 'webhook',
        data: { url: WEBHOOK_URL, secret: WEBHOOK_SECRET, events },
        // Some versions read these flat instead of nested in `data`:
        url: WEBHOOK_URL,
        secret: WEBHOOK_SECRET,
        events,
      }
    );
    webhook = entity;
    console.log(`  ${created ? 'Created' : 'Reused '} webhook ${webhook.id}  ${WEBHOOK_URL}`);
  } catch (e) {
    if (e.response?.status === 404) {
      // Older Bitcart used /webhooks scoped to the store.
      webhookEndpoint = `/stores/${store.id}/webhooks`;
      const { entity, created } = await findOrCreate(
        webhookEndpoint,
        x => x.url === WEBHOOK_URL,
        { url: WEBHOOK_URL, secret: WEBHOOK_SECRET, events }
      );
      webhook = entity;
      console.log(`  ${created ? 'Created' : 'Reused '} webhook ${webhook.id}  ${WEBHOOK_URL}`);
    } else {
      throw e;
    }
  }

  console.log('\nDone. Set the following on Render → Environment:\n');
  console.log(`  BITCART_API_URL=${API_URL}`);
  console.log(`  BITCART_API_TOKEN=${TOKEN}`);
  console.log(`  BITCART_STORE_ID=${store.id}`);
  console.log(`  BITCART_WEBHOOK_SECRET=${WEBHOOK_SECRET}`);
  console.log(`\nThen redeploy. /api/config will report bitcart=true and the\n"Self-hosted (Bitcart)" tile will appear on /pay.html.\n`);
})().catch(err => {
  const detail = err.response?.data || err.message;
  console.error('\nBootstrap failed:', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  console.error('\nIf this is a 401, the BITCART_BOOTSTRAP_TOKEN is invalid or lacks the server_management permission.');
  console.error('If this is a 422 on /wallets, the daemon for that currency is not running in your bitcart-docker stack.');
  process.exit(3);
});
