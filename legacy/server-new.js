/**
 * ============================================
 * POFFBANK PAYMENT GATEWAY - PRODUCTION SERVER
 * ============================================
 * A Stripe-style payment gateway powered by NOWPayments
 * Supports Visa, Mastercard, and Crypto payments
 * Auto-converts to USDT TRC20
 * 
 * API Keys: VB6E96H-VSFM9M2-MFETDV4-RY6JM7K, FXY3NBV-E4MMGSM-GB7GTVT-Q8HK2FP
 * Backend: https://poffbank-api.onrender.com/
 * Frontend: https://carlin5.netlify.app
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// CONFIGURATION
// ============================================
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'VB6E96H-VSFM9M2-MFETDV4-RY6JM7K';
const NOWPAYMENTS_API_KEY_SECONDARY = process.env.NOWPAYMENTS_API_KEY_SECONDARY || 'FXY3NBV-E4MMGSM-GB7GTVT-Q8HK2FP';
const NOWPAYMENTS_API_URL = 'https://api.nowpayments.io/v1';
const USDT_TRC20_WALLET = process.env.USDT_TRC20_WALLET || 'TURXbzSQQKTiA6fqMzsZMaFQyXAU7o2nXh';

const BASE_URL = process.env.BASE_URL || 'https://poffbank-api.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://carlin5.netlify.app';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

const COMPANY_NAME = process.env.COMPANY_NAME || 'PoffBank';
const COMPANY_LOGO = process.env.COMPANY_LOGO_URL || 'https://poffbank.com/assets/logo.png';

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: [FRONTEND_URL, 'https://poffbank.com', 'http://localhost:3000', 'http://127.0.0.1:5500', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true
}));
app.use(express.json());
app.use(express.static('.'));

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Request Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Rate Limiting (simple in-memory)
const requestCounts = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const windowStart = now - 900000; // 15 minutes
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }
  
  const requests = requestCounts.get(ip).filter(time => time > windowStart);
  requests.push(now);
  requestCounts.set(ip, requests);
  
  if (requests.length > 100) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  
  next();
});

// ============================================
// IN-MEMORY DATABASE (REPLACE WITH MONGODB IN PRODUCTION)
// ============================================
const Database = {
  invoices: new Map(),
  transactions: new Map(),
  webhookLogs: new Map(),
  merchants: new Map(),
  
  createInvoice(data) {
    const id = uuidv4();
    const orderId = `POB-${Date.now().toString(36).toUpperCase()}`;
    const invoice = {
      id,
      orderId,
      ...data,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.invoices.set(id, invoice);
    this.invoices.set(orderId, invoice); // Also index by orderId
    return invoice;
  },
  
  getInvoice(id) {
    return this.invoices.get(id);
  },
  
  getInvoiceByOrderId(orderId) {
    return this.invoices.get(orderId);
  },
  
  updateInvoice(id, updates) {
    const invoice = this.invoices.get(id);
    if (!invoice) return null;
    const updated = { ...invoice, ...updates, updatedAt: new Date().toISOString() };
    this.invoices.set(id, updated);
    this.invoices.set(invoice.orderId, updated);
    return updated;
  },
  
  getAllInvoices(merchantId = 'default') {
    return Array.from(this.invoices.values())
      .filter(inv => inv.merchantId === merchantId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  
  createTransaction(data) {
    const id = uuidv4();
    const tx = {
      id,
      ...data,
      createdAt: new Date().toISOString()
    };
    this.transactions.set(id, tx);
    return tx;
  },
  
  getTransactionsByInvoice(invoiceId) {
    return Array.from(this.transactions.values())
      .filter(tx => tx.invoiceId === invoiceId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  
  logWebhook(data) {
    const id = uuidv4();
    const log = {
      id,
      ...data,
      receivedAt: new Date().toISOString()
    };
    this.webhookLogs.set(id, log);
    return log;
  }
};

// Initialize default merchant
Database.merchants.set('default', {
  id: 'default',
  name: COMPANY_NAME,
  logo: COMPANY_LOGO,
  wallet: USDT_TRC20_WALLET,
  email: 'support@poffbank.com',
  createdAt: new Date().toISOString()
});

// ============================================
// NOWPAYMENTS API CLIENT
// ============================================
const nowPaymentsAPI = axios.create({
  baseURL: NOWPAYMENTS_API_URL,
  headers: {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// API Functions
async function getMinimumPaymentAmount(currencyFrom = 'usd', currencyTo = 'usdttrc20') {
  const response = await nowPaymentsAPI.get(`/min-amount?currency_from=${currencyFrom}&currency_to=${currencyTo}`);
  return response.data;
}

async function getEstimatedPrice(amount, currencyFrom = 'usd', currencyTo = 'usdttrc20') {
  const response = await nowPaymentsAPI.get(`/estimate?amount=${amount}&currency_from=${currencyFrom}&currency_to=${currencyTo}`);
  return response.data;
}

async function getAvailableCurrencies() {
  const response = await nowPaymentsAPI.get('/currencies');
  return response.data;
}

async function createNOWPaymentsInvoice(paymentData) {
  const response = await nowPaymentsAPI.post('/invoice', paymentData);
  return response.data;
}

async function createNOWPaymentsPayment(paymentData) {
  const response = await nowPaymentsAPI.post('/payment', paymentData);
  return response.data;
}

async function getPaymentStatus(paymentId) {
  const response = await nowPaymentsAPI.get(`/payment/${paymentId}`);
  return response.data;
}

async function getInvoiceStatus(invoiceId) {
  const response = await nowPaymentsAPI.get(`/invoice/${invoiceId}`);
  return response.data;
}

// ============================================
// CORE API ENDPOINTS
// ============================================

// Health Check
app.get('/api/health', async (req, res) => {
  try {
    const npStatus = await nowPaymentsAPI.get('/status');
    res.json({
      success: true,
      status: 'healthy',
      service: 'PoffBank Payment Gateway',
      version: '2.0.0',
      nowpayments: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      status: 'degraded',
      error: 'NOWPayments API connection issue'
    });
  }
});

// Get Available Currencies
app.get('/api/currencies', async (req, res) => {
  try {
    const currencies = await getAvailableCurrencies();
    res.json({
      success: true,
      currencies: currencies.currencies || []
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch currencies'
    });
  }
});

// Get Exchange Rate
app.get('/api/exchange-rate', async (req, res) => {
  try {
    const { amount = 1, from = 'usd', to = 'usdttrc20' } = req.query;
    const estimate = await getEstimatedPrice(amount, from, to);
    res.json({
      success: true,
      rate: estimate.estimated_amount / amount,
      estimatedAmount: estimate.estimated_amount,
      currency: to,
      service: COMPANY_NAME
    });
  } catch (error) {
    res.json({
      success: true,
      rate: 1.00,
      currency: 'USDT',
      service: COMPANY_NAME,
      note: 'Using standard rate'
    });
  }
});

// ============================================
// PAYMENT CREATION ENDPOINT
// ============================================
app.post('/api/create-payment', async (req, res) => {
  try {
    const {
      amount,
      currency = 'USD',
      description,
      customerEmail,
      customerName,
      orderId: customOrderId,
      successUrl,
      cancelUrl,
      metadata = {}
    } = req.body;

    // Validation
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount. Must be greater than 0.'
      });
    }

    // Create local invoice record
    const invoice = Database.createInvoice({
      amount: parseFloat(amount),
      currency: currency.toUpperCase(),
      description: description || 'Payment via PoffBank',
      customerEmail,
      customerName,
      merchantId: 'default',
      status: 'pending',
      successUrl: successUrl || `${FRONTEND_URL}/success`,
      cancelUrl: cancelUrl || `${FRONTEND_URL}/cancel`,
      metadata
    });

    // Prepare NOWPayments invoice
    const nowPaymentsPayload = {
      price_amount: parseFloat(amount),
      price_currency: currency.toLowerCase(),
      pay_currency: 'usdttrc20', // Auto-convert to USDT TRC20
      ipn_callback_url: `${BASE_URL}/api/webhook`,
      order_id: invoice.orderId,
      order_description: description || 'Payment via PoffBank',
      customer_email: customerEmail,
      success_url: `${FRONTEND_URL}/invoice/${invoice.id}/success`,
      cancel_url: `${FRONTEND_URL}/invoice/${invoice.id}/cancel`,
      partially_paid_url: `${FRONTEND_URL}/invoice/${invoice.id}/pending`,
      is_fixed_rate: false,
      is_fee_paid_by_user: false
    };

    console.log(`[PoffBank] Creating payment for invoice ${invoice.orderId}`);
    console.log(`[PoffBank] Amount: ${amount} ${currency} -> USDT TRC20`);

    // Create NOWPayments invoice
    const nowInvoice = await createNOWPaymentsInvoice(nowPaymentsPayload);

    // Update invoice with NOWPayments data
    const updatedInvoice = Database.updateInvoice(invoice.id, {
      nowpaymentsInvoiceId: nowInvoice.id,
      nowpaymentsInvoiceUrl: nowInvoice.invoice_url,
      nowpaymentsStatus: nowInvoice.payment_status,
      payAddress: nowInvoice.pay_address,
      payCurrency: nowInvoice.pay_currency,
      payAmount: nowInvoice.pay_amount,
      expirationTime: nowInvoice.expiration_estimate_date,
      paymentUrl: nowInvoice.invoice_url
    });

    // Create transaction record
    Database.createTransaction({
      invoiceId: invoice.id,
      orderId: invoice.orderId,
      type: 'payment_created',
      amount: parseFloat(amount),
      currency: currency.toUpperCase(),
      status: 'pending',
      nowpaymentsId: nowInvoice.id,
      metadata: nowInvoice
    });

    res.json({
      success: true,
      message: 'Payment created successfully',
      data: {
        invoiceId: updatedInvoice.id,
        orderId: updatedInvoice.orderId,
        amount: updatedInvoice.amount,
        currency: updatedInvoice.currency,
        description: updatedInvoice.description,
        status: updatedInvoice.status,
        paymentUrl: updatedInvoice.paymentUrl,
        nowpaymentsInvoiceUrl: updatedInvoice.nowpaymentsInvoiceUrl,
        payAddress: updatedInvoice.payAddress,
        payCurrency: updatedInvoice.payCurrency,
        payAmount: updatedInvoice.payAmount,
        expirationTime: updatedInvoice.expirationTime,
        merchant: {
          name: COMPANY_NAME,
          logo: COMPANY_LOGO
        },
        checkoutUrl: `${FRONTEND_URL}/checkout/${updatedInvoice.id}`,
        createdAt: updatedInvoice.createdAt
      }
    });

  } catch (error) {
    console.error('[PoffBank] Payment creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create payment',
      details: error.response?.data || error.message
    });
  }
});

// ============================================
// INVOICE ENDPOINTS
// ============================================

// Get Invoice by ID
app.get('/api/invoice/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let invoice = Database.getInvoice(id);
    
    // Try by orderId if not found by id
    if (!invoice) {
      invoice = Database.getInvoiceByOrderId(id);
    }
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }

    // If has NOWPayments ID, check current status
    if (invoice.nowpaymentsInvoiceId) {
      try {
        const npStatus = await getInvoiceStatus(invoice.nowpaymentsInvoiceId);
        if (npStatus.payment_status !== invoice.nowpaymentsStatus) {
          invoice = Database.updateInvoice(invoice.id, {
            nowpaymentsStatus: npStatus.payment_status,
            status: mapNOWPaymentsStatus(npStatus.payment_status)
          });
        }
      } catch (e) {
        console.log('[PoffBank] Could not refresh status:', e.message);
      }
    }

    res.json({
      success: true,
      invoice: {
        id: invoice.id,
        orderId: invoice.orderId,
        amount: invoice.amount,
        currency: invoice.currency,
        description: invoice.description,
        status: invoice.status,
        customerEmail: invoice.customerEmail,
        customerName: invoice.customerName,
        payAddress: invoice.payAddress,
        payCurrency: invoice.payCurrency,
        payAmount: invoice.payAmount,
        paymentUrl: invoice.paymentUrl,
        nowpaymentsInvoiceUrl: invoice.nowpaymentsInvoiceUrl,
        expirationTime: invoice.expirationTime,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        merchant: {
          name: COMPANY_NAME,
          logo: COMPANY_LOGO
        }
      }
    });

  } catch (error) {
    console.error('[PoffBank] Get invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve invoice'
    });
  }
});

// Get All Invoices (for dashboard)
app.get('/api/invoices', (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let invoices = Database.getAllInvoices('default');
    
    if (status) {
      invoices = invoices.filter(inv => inv.status === status);
    }
    
    const total = invoices.length;
    invoices = invoices.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    res.json({
      success: true,
      data: {
        invoices: invoices.map(inv => ({
          id: inv.id,
          orderId: inv.orderId,
          amount: inv.amount,
          currency: inv.currency,
          description: inv.description,
          status: inv.status,
          customerEmail: inv.customerEmail,
          createdAt: inv.createdAt,
          updatedAt: inv.updatedAt
        })),
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (error) {
    console.error('[PoffBank] Get invoices error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve invoices'
    });
  }
});

// ============================================
// PAYMENT STATUS ENDPOINT
// ============================================
app.get('/api/payment-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let invoice = Database.getInvoice(id);
    
    if (!invoice) {
      invoice = Database.getInvoiceByOrderId(id);
    }
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found'
      });
    }

    // Check NOWPayments for updated status
    if (invoice.nowpaymentsInvoiceId) {
      try {
        const npStatus = await getInvoiceStatus(invoice.nowpaymentsInvoiceId);
        
        if (npStatus.payment_status !== invoice.nowpaymentsStatus) {
          invoice = Database.updateInvoice(invoice.id, {
            nowpaymentsStatus: npStatus.payment_status,
            status: mapNOWPaymentsStatus(npStatus.payment_status),
            paidAmount: npStatus.actually_paid,
            paidCurrency: npStatus.pay_currency,
            transactionHash: npStatus.txHash || npStatus.payment_hash
          });
        }
      } catch (e) {
        console.log('[PoffBank] Status check error:', e.message);
      }
    }

    res.json({
      success: true,
      data: {
        invoiceId: invoice.id,
        orderId: invoice.orderId,
        status: invoice.status,
        nowpaymentsStatus: invoice.nowpaymentsStatus,
        amount: invoice.amount,
        currency: invoice.currency,
        paidAmount: invoice.paidAmount,
        paidCurrency: invoice.paidCurrency,
        payAddress: invoice.payAddress,
        payAmount: invoice.payAmount,
        payCurrency: invoice.payCurrency,
        transactionHash: invoice.transactionHash,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt
      }
    });

  } catch (error) {
    console.error('[PoffBank] Payment status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get payment status'
    });
  }
});

// ============================================
// WEBHOOK ENDPOINT
// ============================================
app.post('/api/webhook', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('[PoffBank] Webhook received:', JSON.stringify(payload, null, 2));
    
    // Log webhook
    Database.logWebhook({
      payload,
      headers: req.headers,
      ip: req.ip
    });

    // Handle different webhook types
    if (payload.payment_status) {
      // Invoice payment update
      const invoice = Array.from(Database.invoices.values())
        .find(inv => inv.nowpaymentsInvoiceId === payload.id || inv.orderId === payload.order_id);
      
      if (invoice) {
        const newStatus = mapNOWPaymentsStatus(payload.payment_status);
        
        Database.updateInvoice(invoice.id, {
          status: newStatus,
          nowpaymentsStatus: payload.payment_status,
          paidAmount: payload.actually_paid || payload.pay_amount,
          paidCurrency: payload.pay_currency,
          transactionHash: payload.txHash || payload.payment_hash || payload.hash,
          updatedAt: new Date().toISOString()
        });

        // Create transaction record
        Database.createTransaction({
          invoiceId: invoice.id,
          orderId: invoice.orderId,
          type: 'webhook_update',
          status: newStatus,
          nowpaymentsId: payload.id,
          amount: payload.actually_paid || payload.pay_amount,
          currency: payload.pay_currency,
          transactionHash: payload.txHash || payload.payment_hash || payload.hash,
          metadata: payload
        });

        console.log(`[PoffBank] Invoice ${invoice.orderId} status updated to: ${newStatus}`);
      }
    }

    res.json({ success: true });

  } catch (error) {
    console.error('[PoffBank] Webhook error:', error);
    // Always return 200 for webhooks to prevent retries
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// MERCHANT DASHBOARD API
// ============================================

// Get Dashboard Stats
app.get('/api/dashboard/stats', (req, res) => {
  try {
    const invoices = Database.getAllInvoices('default');
    
    const stats = {
      totalInvoices: invoices.length,
      totalAmount: invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0),
      completedPayments: invoices.filter(inv => inv.status === 'completed').length,
      pendingPayments: invoices.filter(inv => inv.status === 'pending').length,
      failedPayments: invoices.filter(inv => inv.status === 'failed').length,
      recentTransactions: invoices.slice(0, 5).map(inv => ({
        id: inv.id,
        orderId: inv.orderId,
        amount: inv.amount,
        currency: inv.currency,
        status: inv.status,
        createdAt: inv.createdAt
      }))
    };
    
    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('[PoffBank] Dashboard stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dashboard stats'
    });
  }
});

// Get Wallet Info
app.get('/api/wallet', (req, res) => {
  res.json({
    success: true,
    data: {
      address: USDT_TRC20_WALLET,
      currency: 'USDT',
      network: 'TRC20',
      merchant: COMPANY_NAME
    }
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function mapNOWPaymentsStatus(npStatus) {
  const statusMap = {
    'waiting': 'pending',
    'confirming': 'processing',
    'confirmed': 'processing',
    'sending': 'processing',
    'partially_paid': 'pending',
    'finished': 'completed',
    'failed': 'failed',
    'expired': 'expired',
    'refunded': 'refunded'
  };
  return statusMap[npStatus] || npStatus;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// ERROR HANDLING
// ============================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /api/health',
      'POST /api/create-payment',
      'GET /api/invoice/:id',
      'GET /api/invoices',
      'GET /api/payment-status/:id',
      'POST /api/webhook',
      'GET /api/dashboard/stats',
      'GET /api/currencies',
      'GET /api/exchange-rate'
    ]
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[PoffBank] Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ============================================
// SERVER STARTUP
// ============================================

const server = app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  POFFBANK PAYMENT GATEWAY v2.0');
  console.log('========================================');
  console.log(`  Server running on port: ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  NOWPayments: ${NOWPAYMENTS_API_KEY ? 'Connected' : 'Not configured'}`);
  console.log(`  Payout Wallet: ${USDT_TRC20_WALLET.substring(0, 10)}...`);
  console.log(`  API Base: ${BASE_URL}`);
  console.log('========================================');
  console.log('  Available Endpoints:');
  console.log('  - POST /api/create-payment');
  console.log('  - GET  /api/invoice/:id');
  console.log('  - GET  /api/invoices');
  console.log('  - GET  /api/payment-status/:id');
  console.log('  - POST /api/webhook');
  console.log('========================================');
  console.log('');
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('[PoffBank] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('[PoffBank] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[PoffBank] SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('[PoffBank] Server closed');
    process.exit(0);
  });
});
