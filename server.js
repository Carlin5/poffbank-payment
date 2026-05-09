const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CONFIGURATION - POFFBANK ONLY (NO NOWPAYMENTS VISIBLE TO CUSTOMERS)
// ============================================
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'BT0AHVQ-MM8M4Z2-H57T2NC-V4EM2QG';
const NOWPAYMENTS_API_URL = 'https://api.nowpayments.io/v1';
const USDT_WALLET = 'TURXbzSQQKTiA6fqMzsZMaFQyXAU7o2nXh'; // Your USDT TRC20 wallet

// JWT Secret for authentication (generate in production)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: ['https://carlin5.netlify.app', 'https://poffbank.com', 'http://localhost:3000', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true
}));
app.use(express.json());
app.use(express.static('.'));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// IN-MEMORY STORAGE (USE DATABASE IN PRODUCTION)
// ============================================
const payments = new Map();
const withdrawals = new Map();
const recurringPayments = new Map();

// ============================================
// NOWPAYMENTS API CLIENT (HIDDEN FROM CUSTOMERS)
// ============================================
const nowPaymentsAPI = axios.create({
  baseURL: NOWPAYMENTS_API_URL,
  headers: {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

// Get authentication status
app.get('/api/auth/status', async (req, res) => {
  try {
    // Verify API key is valid by checking status
    const response = await nowPaymentsAPI.get('/status');
    res.json({
      success: true,
      authenticated: true,
      message: 'PoffBank Payment Gateway Active',
      nowpayments_status: response.data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      authenticated: false,
      message: 'Authentication failed',
      error: error.message
    });
  }
});

// ============================================
// PAYMENT PROCESSING - NOWPAYMENTS BACKEND
// ============================================

// Get minimum payment amount
async function getMinimumPaymentAmount(currencyFrom = 'usd', currencyTo = 'usdttrc20') {
  const response = await nowPaymentsAPI.get(`/min-amount?currency_from=${currencyFrom}&currency_to=${currencyTo}`);
  return response.data;
}

// Get estimated price
async function getEstimatedPrice(amount, currencyFrom = 'usd', currencyTo = 'usdttrc20') {
  const response = await nowPaymentsAPI.get(`/estimate?amount=${amount}&currency_from=${currencyFrom}&currency_to=${currencyTo}`);
  return response.data;
}

// Create NOWPayments payment
async function createNowPayment(amount, orderId, email, description) {
  const paymentData = {
    price_amount: amount,
    price_currency: 'usd',
    pay_currency: 'usdttrc20',
    order_id: orderId,
    order_description: description || `PoffBank Payment - ${orderId}`,
    ipn_callback_url: `${process.env.BASE_URL || `https://poffbank-api.onrender.com`}/api/webhook/payment`,
    success_url: `${process.env.BASE_URL || `https://poffbank-api.onrender.com`}/payment/success?order_id=${orderId}`,
    cancel_url: `${process.env.BASE_URL || `https://poffbank-api.onrender.com`}/payment/cancel?order_id=${orderId}`,
    customer_email: email,
    is_fixed_rate: true,
    case: 'fiat'
  };

  const response = await nowPaymentsAPI.post('/payment', paymentData);
  return response.data;
}

// Get payment status from NOWPayments
async function getNowPaymentStatus(paymentId) {
  const response = await nowPaymentsAPI.get(`/payment/${paymentId}`);
  return response.data;
}

// ============================================
// WITHDRAWAL FUNCTIONS - NOWPAYMENTS BACKEND
// ============================================

// Create withdrawal
async function createWithdrawal(amount, address, currency = 'usdttrc20') {
  const withdrawalData = {
    currency: currency,
    amount: amount.toString(),
    address: address,
    ipn_callback_url: `${process.env.BASE_URL || `https://poffbank-api.onrender.com`}/api/webhook/withdrawal`
  };

  const response = await nowPaymentsAPI.post('/withdrawal', withdrawalData);
  return response.data;
}

// Get withdrawal status
async function getWithdrawalStatus(withdrawalId) {
  const response = await nowPaymentsAPI.get(`/withdrawal/${withdrawalId}`);
  return response.data;
}

// ============================================
// RECURRING PAYMENTS - NOWPAYMENTS BACKEND
// ============================================

// Create recurring payment
async function createRecurringPayment(amount, currency, ipnUrl) {
  const paymentData = {
    currency: currency,
    amount: amount.toString(),
    ipn_callback_url: ipnUrl || `${process.env.BASE_URL || `https://poffbank-api.onrender.com`}/api/webhook/recurring`
  };

  const response = await nowPaymentsAPI.post('/recurring-payments', paymentData);
  return response.data;
}

// Get recurring payment status
async function getRecurringPaymentStatus(paymentId) {
  const response = await nowPaymentsAPI.get(`/recurring-payments/${paymentId}`);
  return response.data;
}

// ============================================
// API Routes - POFFBANK BRANDED (NO NOWPAYMENTS VISIBLE)
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'PoffBank Payment Gateway',
    timestamp: new Date().toISOString(),
    features: ['payments', 'withdrawals', 'recurring']
  });
});

// Get exchange rate (backend NOWPayments, frontend sees PoffBank)
app.get('/api/exchange-rate', async (req, res) => {
  try {
    const estimate = await getEstimatedPrice(1, 'usd', 'usdttrc20');
    res.json({
      success: true,
      rate: estimate.estimated_amount,
      currency: 'USDT',
      service: 'PoffBank Exchange'
    });
  } catch (error) {
    console.error('Exchange rate error:', error.message);
    res.json({
      success: true,
      rate: 1.00,
      currency: 'USDT',
      service: 'PoffBank Exchange',
      note: 'Using standard rate'
    });
  }
});

// Create payment - PoffBank branded
app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, email, cardData, description } = req.body;
    console.log('[PoffBank] Payment request:', { amount, email, description });

    // Validate input
    if (!amount || parseFloat(amount) < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount. Minimum $1.00 USD.'
      });
    }

    // Generate PoffBank order ID
    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Store payment in PoffBank system
    const paymentInfo = {
      orderId,
      amount: parseFloat(amount),
      email,
      cardLast4: cardData?.cardNumber ? cardData.cardNumber.slice(-4) : null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      nowPaymentId: null,
      nowPaymentStatus: null,
      payAddress: USDT_WALLET
    };

    payments.set(orderId, paymentInfo);

    // Create NOWPayments payment (backend only - customer never sees NOWPayments)
    let nowPayment = null;
    try {
      nowPayment = await createNowPayment(amount, orderId, email, description);
      paymentInfo.nowPaymentId = nowPayment.payment_id;
      paymentInfo.nowPaymentStatus = nowPayment.payment_status;
      paymentInfo.payAddress = nowPayment.pay_address || USDT_WALLET;
      payments.set(orderId, paymentInfo);
      console.log(`[PoffBank] Payment ${orderId} linked to NOWPayments ${nowPayment.payment_id}`);
    } catch (nowError) {
      console.error('[PoffBank] NOWPayments error:', nowError.message);
      // Continue with PoffBank payment even if NOWPayments fails
      paymentInfo.nowPaymentStatus = 'pending_backend';
    }

    // Return PoffBank branded response (NO NOWPAYMENTS DATA VISIBLE)
    res.json({
      success: true,
      orderId,
      status: 'pending',
      amount: amount,
      currency: 'USD',
      destinationWallet: paymentInfo.payAddress.substring(0, 6) + '...' + paymentInfo.payAddress.substring(-4),
      message: 'Payment initialized. Proceed to complete transaction.',
      validUntil: new Date(Date.now() + 3600000).toISOString()
    });

  } catch (error) {
    console.error('[PoffBank] Payment creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment processing unavailable. Please try again.'
    });
  }
});

// Get payment status - PoffBank branded
app.get('/api/payment/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const paymentInfo = payments.get(orderId);

    if (!paymentInfo) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    // Check NOWPayments status in background (customer never sees this)
    if (paymentInfo.nowPaymentId) {
      try {
        const nowStatus = await getNowPaymentStatus(paymentInfo.nowPaymentId);
        paymentInfo.nowPaymentStatus = nowStatus.payment_status;
        
        // Update PoffBank status based on backend status
        if (nowStatus.payment_status === 'finished' || nowStatus.payment_status === 'confirmed') {
          paymentInfo.status = 'completed';
        } else if (nowStatus.payment_status === 'failed' || nowStatus.payment_status === 'expired') {
          paymentInfo.status = 'failed';
        } else if (nowStatus.payment_status === 'confirming' || nowStatus.payment_status === 'sending') {
          paymentInfo.status = 'processing';
        }
        
        payments.set(orderId, paymentInfo);
      } catch (e) {
        console.log('[PoffBank] Could not sync with backend');
      }
    }

    // Return PoffBank branded response
    res.json({
      success: true,
      orderId,
      status: paymentInfo.status,
      amount: paymentInfo.amount,
      currency: 'USD',
      createdAt: paymentInfo.createdAt,
      message: paymentInfo.status === 'completed' ? 'Payment confirmed' : 'Payment in progress'
    });

  } catch (error) {
    console.error('[PoffBank] Status check error:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to retrieve transaction status'
    });
  }
});

// Complete payment (called after successful card processing)
app.post('/api/payment/complete', async (req, res) => {
  try {
    const { orderId, transactionHash } = req.body;
    const paymentInfo = payments.get(orderId);

    if (!paymentInfo) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found'
      });
    }

    // Mark as completed
    paymentInfo.status = 'completed';
    paymentInfo.completedAt = new Date().toISOString();
    paymentInfo.transactionHash = transactionHash || `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    payments.set(orderId, paymentInfo);

    res.json({
      success: true,
      orderId,
      transactionHash: paymentInfo.transactionHash,
      status: 'completed'
    });

  } catch (error) {
    console.error('Complete payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete payment'
    });
  }
});

// ============================================
// Frontend Routes
// ============================================

// Payment success page
app.get('/payment/success', (req, res) => {
  res.redirect(`/?status=success&order_id=${req.query.order_id}`);
});

// Payment cancel page
app.get('/payment/cancel', (req, res) => {
  res.redirect(`/?status=cancelled&order_id=${req.query.order_id}`);
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║          PoffBank Payment Gateway Server                 ║
║                                                        ║
║  Status: Running                                       ║
║  Port: ${PORT}                                           ║
║  NOWPayments: Integrated                               ║
║                                                        ║
║  API Endpoints:                                        ║
║  • GET  /api/health                                    ║
║  • GET  /api/exchange-rate                             ║
║  • POST /api/payment/create                            ║
║  • GET  /api/payment/status/:orderId                   ║
║  • POST /api/payment/callback                          ║
║                                                        ║
║  Customer UI: Clean PoffBank Branding Only             ║
║  Backend: NOWPayments API Integration Active           ║
╚════════════════════════════════════════════════════════╝
  `);
});

// ============================================
// WEBHOOK ENDPOINTS - NOWPAYMENTS CALLBACKS
// ============================================

// Payment webhook - NOWPayments sends payment updates here
app.post('/api/webhook/payment', async (req, res) => {
  try {
    const data = req.body;
    console.log('[PoffBank Webhook] Payment update:', data);
    
    const { 
      payment_id, 
      payment_status, 
      order_id,
      pay_amount,
      pay_currency,
      actually_paid,
      outcome_amount,
      outcome_currency
    } = data;

    // Find payment in PoffBank system
    for (const [key, payment] of payments.entries()) {
      if (payment.nowPaymentId === payment_id || payment.orderId === order_id) {
        // Update with NOWPayments data
        payment.nowPaymentStatus = payment_status;
        payment.payAmount = pay_amount;
        payment.payCurrency = pay_currency;
        payment.actuallyPaid = actually_paid;
        payment.outcomeAmount = outcome_amount;
        payment.outcomeCurrency = outcome_currency;
        
        // Update PoffBank status
        if (payment_status === 'finished' || payment_status === 'confirmed') {
          payment.status = 'completed';
          payment.completedAt = new Date().toISOString();
        } else if (payment_status === 'failed' || payment_status === 'expired' || payment_status === 'refunded') {
          payment.status = 'failed';
        } else if (payment_status === 'confirming' || payment_status === 'sending' || payment_status === 'waiting') {
          payment.status = 'processing';
        }
        
        payments.set(key, payment);
        console.log(`[PoffBank] Payment ${key} updated: ${payment.status}`);
        break;
      }
    }

    // Always return 200 to NOWPayments
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[PoffBank Webhook] Error:', error);
    res.status(200).json({ received: true }); // Always 200
  }
});

// Withdrawal webhook
app.post('/api/webhook/withdrawal', async (req, res) => {
  try {
    const data = req.body;
    console.log('[PoffBank Webhook] Withdrawal update:', data);
    
    const { id, status, batch_withdrawal_id, hash } = data;
    
    // Update withdrawal status
    for (const [key, withdrawal] of withdrawals.entries()) {
      if (withdrawal.nowWithdrawalId === id || withdrawal.batchId === batch_withdrawal_id) {
        withdrawal.status = status;
        withdrawal.txHash = hash;
        withdrawals.set(key, withdrawal);
        console.log(`[PoffBank] Withdrawal ${key} updated: ${status}`);
        break;
      }
    }
    
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[PoffBank Webhook] Withdrawal error:', error);
    res.status(200).json({ received: true });
  }
});

// Recurring payment webhook
app.post('/api/webhook/recurring', async (req, res) => {
  try {
    const data = req.body;
    console.log('[PoffBank Webhook] Recurring payment:', data);
    
    const { id, status, currency, amount } = data;
    
    // Store recurring payment update
    const recurringInfo = {
      nowPaymentId: id,
      status: status,
      currency: currency,
      amount: amount,
      updatedAt: new Date().toISOString()
    };
    
    recurringPayments.set(id, recurringInfo);
    console.log(`[PoffBank] Recurring payment ${id}: ${status}`);
    
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[PoffBank Webhook] Recurring error:', error);
    res.status(200).json({ received: true });
  }
});

// ============================================
// WITHDRAWAL API - POFFBANK BRANDED
// ============================================

// Create withdrawal
app.post('/api/withdrawal/create', async (req, res) => {
  try {
    const { amount, address, currency = 'usdttrc20' } = req.body;
    
    console.log('[PoffBank] Withdrawal request:', { amount, address, currency });
    
    // Validate
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid withdrawal amount'
      });
    }
    
    if (!address) {
      return res.status(400).json({
        success: false,
        error: 'Destination address required'
      });
    }
    
    // Generate withdrawal ID
    const withdrawalId = `WD-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    
    // Store withdrawal info
    const withdrawalInfo = {
      withdrawalId,
      amount: parseFloat(amount),
      address: address,
      currency: currency,
      status: 'pending',
      createdAt: new Date().toISOString(),
      nowWithdrawalId: null
    };
    
    withdrawals.set(withdrawalId, withdrawalInfo);
    
    // Create NOWPayments withdrawal (backend only)
    try {
      const nowWithdrawal = await createWithdrawal(amount, address, currency);
      withdrawalInfo.nowWithdrawalId = nowWithdrawal.id;
      withdrawalInfo.batchId = nowWithdrawal.batch_withdrawal_id;
      withdrawalInfo.status = nowWithdrawal.status || 'pending';
      withdrawals.set(withdrawalId, withdrawalInfo);
      console.log(`[PoffBank] Withdrawal ${withdrawalId} created with NOWPayments ${nowWithdrawal.id}`);
    } catch (nowError) {
      console.error('[PoffBank] NOWPayments withdrawal error:', nowError.message);
      withdrawalInfo.status = 'pending_backend';
    }
    
    // Return PoffBank branded response
    res.json({
      success: true,
      withdrawalId,
      status: withdrawalInfo.status,
      amount: amount,
      currency: currency.toUpperCase(),
      destination: address.substring(0, 6) + '...' + address.substring(-4),
      message: 'Withdrawal initiated',
      createdAt: withdrawalInfo.createdAt
    });
    
  } catch (error) {
    console.error('[PoffBank] Withdrawal error:', error);
    res.status(500).json({
      success: false,
      error: 'Withdrawal processing failed'
    });
  }
});

// Get withdrawal status
app.get('/api/withdrawal/status/:withdrawalId', async (req, res) => {
  try {
    const { withdrawalId } = req.params;
    const withdrawal = withdrawals.get(withdrawalId);
    
    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        error: 'Withdrawal not found'
      });
    }
    
    // Check NOWPayments status in background
    if (withdrawal.nowWithdrawalId) {
      try {
        const nowStatus = await getWithdrawalStatus(withdrawal.nowWithdrawalId);
        withdrawal.status = nowStatus.status || withdrawal.status;
        withdrawal.txHash = nowStatus.hash || withdrawal.txHash;
        withdrawals.set(withdrawalId, withdrawal);
      } catch (e) {
        console.log('[PoffBank] Could not sync withdrawal status');
      }
    }
    
    res.json({
      success: true,
      withdrawalId,
      status: withdrawal.status,
      amount: withdrawal.amount,
      currency: withdrawal.currency.toUpperCase(),
      txHash: withdrawal.txHash,
      createdAt: withdrawal.createdAt
    });
    
  } catch (error) {
    console.error('[PoffBank] Withdrawal status error:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to retrieve withdrawal status'
    });
  }
});

// ============================================
// RECURRING PAYMENTS API - POFFBANK BRANDED
// ============================================

// Create recurring payment
app.post('/api/recurring/create', async (req, res) => {
  try {
    const { amount, currency, description } = req.body;
    
    console.log('[PoffBank] Recurring payment request:', { amount, currency });
    
    // Generate subscription ID
    const subscriptionId = `SUB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    
    // Store recurring payment info
    const recurringInfo = {
      subscriptionId,
      amount: parseFloat(amount),
      currency: currency || 'usdttrc20',
      status: 'pending',
      createdAt: new Date().toISOString(),
      nowPaymentId: null
    };
    
    recurringPayments.set(subscriptionId, recurringInfo);
    
    // Create NOWPayments recurring payment
    try {
      const nowRecurring = await createRecurringPayment(
        amount, 
        currency || 'usdttrc20',
        `${process.env.BASE_URL}/api/webhook/recurring`
      );
      recurringInfo.nowPaymentId = nowRecurring.id;
      recurringInfo.status = nowRecurring.status || 'active';
      recurringPayments.set(subscriptionId, recurringInfo);
      console.log(`[PoffBank] Recurring ${subscriptionId} created with NOWPayments ${nowRecurring.id}`);
    } catch (nowError) {
      console.error('[PoffBank] NOWPayments recurring error:', nowError.message);
      recurringInfo.status = 'pending_backend';
    }
    
    res.json({
      success: true,
      subscriptionId,
      status: recurringInfo.status,
      amount: amount,
      currency: (currency || 'usdttrc20').toUpperCase(),
      message: 'Recurring payment scheduled',
      createdAt: recurringInfo.createdAt
    });
    
  } catch (error) {
    console.error('[PoffBank] Recurring payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create recurring payment'
    });
  }
});

// Get recurring payment status
app.get('/api/recurring/status/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const recurring = recurringPayments.get(subscriptionId);
    
    if (!recurring) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
    }
    
    // Check NOWPayments status
    if (recurring.nowPaymentId) {
      try {
        const nowStatus = await getRecurringPaymentStatus(recurring.nowPaymentId);
        recurring.status = nowStatus.status || recurring.status;
        recurringPayments.set(subscriptionId, recurring);
      } catch (e) {
        console.log('[PoffBank] Could not sync recurring status');
      }
    }
    
    res.json({
      success: true,
      subscriptionId,
      status: recurring.status,
      amount: recurring.amount,
      currency: recurring.currency.toUpperCase(),
      createdAt: recurring.createdAt
    });
    
  } catch (error) {
    console.error('[PoffBank] Recurring status error:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to retrieve subscription status'
    });
  }
});

// ============================================
// FRONTEND ROUTES
// ============================================

// Payment success redirect
app.get('/payment/success', (req, res) => {
  res.redirect(`https://carlin5.netlify.app/?status=success&order_id=${req.query.order_id}`);
});

// Payment cancel redirect
app.get('/payment/cancel', (req, res) => {
  res.redirect(`https://carlin5.netlify.app/?status=cancelled&order_id=${req.query.order_id}`);
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    PoffBank Payment Gateway                     ║
║                                                                ║
║  Status:           ACTIVE                                     ║
║  Port:             ${PORT}                                          ║
║  NOWPayments:      Integrated (Hidden from customers)         ║
║  USDT Wallet:      ${USDT_WALLET.substring(0, 10)}...${USDT_WALLET.substring(-6)}        ║
║                                                                ║
║  API ENDPOINTS:                                                ║
║  • GET  /api/auth/status        - Authentication status       ║
║  • GET  /api/health              - Health check                 ║
║  • GET  /api/exchange-rate       - USD/USDT rate                ║
║  • POST /api/payment/create      - Create payment               ║
║  • GET  /api/payment/status/:id  - Payment status               ║
║  • POST /api/payment/complete    - Complete payment               ║
║  • POST /api/withdrawal/create   - Create withdrawal            ║
║  • GET  /api/withdrawal/status/:id - Withdrawal status          ║
║  • POST /api/recurring/create    - Create recurring payment     ║
║  • GET  /api/recurring/status/:id - Recurring status          ║
║                                                                ║
║  WEBHOOKS (NOWPayments):                                       ║
║  • POST /api/webhook/payment     - Payment updates              ║
║  • POST /api/webhook/withdrawal  - Withdrawal updates           ║
║  • POST /api/webhook/recurring   - Recurring updates            ║
║                                                                ║
║  CUSTOMER UI: Clean PoffBank Branding ONLY                     ║
║  BACKEND:     NOWPayments API (Hidden)                        ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
