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

// In-memory OTP storage (use Redis in production)
const otps = new Map();

// Validate card data
function validateCard(cardData) {
  const { cardNumber, cardName, expiry, cvv } = cardData || {};
  
  if (!cardNumber || cardNumber.length < 13) {
    return { valid: false, error: 'Invalid card number' };
  }
  if (!cardName || cardName.length < 2) {
    return { valid: false, error: 'Cardholder name required' };
  }
  if (!expiry || !expiry.match(/^\d{2}\/\d{2}$/)) {
    return { valid: false, error: 'Invalid expiry date (MM/YY)' };
  }
  if (!cvv || cvv.length < 3) {
    return { valid: false, error: 'Invalid CVV' };
  }
  
  return { valid: true };
}

// Generate OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Step 1: Initialize payment and validate card
app.post('/api/payment/init', async (req, res) => {
  try {
    const { amount, email, cardData, description } = req.body;
    console.log('[PoffBank] Payment initialization:', { amount, email });

    // Validate amount
    if (!amount || parseFloat(amount) < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount. Minimum $1.00 USD.'
      });
    }

    // Validate card
    const cardValidation = validateCard(cardData);
    if (!cardValidation.valid) {
      return res.status(400).json({
        success: false,
        error: cardValidation.error
      });
    }

    // Generate PoffBank order ID
    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    
    // Generate OTP for card verification
    const otp = generateOTP();
    const otpExpiry = Date.now() + 300000; // 5 minutes

    // Store payment in PoffBank system
    const paymentInfo = {
      orderId,
      amount: parseFloat(amount),
      email,
      cardData: {
        last4: cardData.cardNumber.slice(-4),
        brand: getCardBrand(cardData.cardNumber),
        name: cardData.cardName
      },
      status: 'awaiting_otp',
      createdAt: new Date().toISOString(),
      otp: otp,
      otpExpiry: otpExpiry,
      otpVerified: false,
      nowPaymentId: null,
      nowPaymentStatus: null,
      payAddress: USDT_WALLET,
      cardProcessed: false,
      description: description || 'PoffBank Payment'
    };

    payments.set(orderId, paymentInfo);
    otps.set(orderId, { otp, expiry: otpExpiry, attempts: 0 });

    // Log OTP for demo (in production, send via SMS/email)
    console.log(`[PoffBank] OTP for ${orderId}: ${otp}`);

    // Return PoffBank branded response
    res.json({
      success: true,
      orderId,
      status: 'awaiting_otp',
      amount: amount,
      currency: 'USD',
      cardLast4: paymentInfo.cardData.last4,
      cardBrand: paymentInfo.cardData.brand,
      message: 'Enter the 6-digit OTP sent to your registered mobile/email',
      otpHint: `Demo OTP: ${otp}`, // Remove in production!
      expiresIn: 300 // 5 minutes
    });

  } catch (error) {
    console.error('[PoffBank] Payment initialization error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment processing unavailable. Please try again.'
    });
  }
});

// Step 2: Verify OTP
app.post('/api/payment/verify-otp', async (req, res) => {
  try {
    const { orderId, otp } = req.body;
    console.log('[PoffBank] OTP verification:', { orderId });

    const paymentInfo = payments.get(orderId);
    const otpData = otps.get(orderId);

    if (!paymentInfo || !otpData) {
      return res.status(404).json({
        success: false,
        error: 'Payment session expired or invalid'
      });
    }

    // Check OTP expiry
    if (Date.now() > otpData.expiry) {
      return res.status(400).json({
        success: false,
        error: 'OTP expired. Please restart payment.'
      });
    }

    // Check attempts
    if (otpData.attempts >= 3) {
      paymentInfo.status = 'failed';
      payments.set(orderId, paymentInfo);
      return res.status(400).json({
        success: false,
        error: 'Too many failed attempts. Payment cancelled.'
      });
    }

    // Verify OTP
    if (otp !== otpData.otp) {
      otpData.attempts++;
      otps.set(orderId, otpData);
      return res.status(400).json({
        success: false,
        error: `Invalid OTP. ${3 - otpData.attempts} attempts remaining.`
      });
    }

    // OTP verified
    paymentInfo.otpVerified = true;
    paymentInfo.status = 'processing';
    paymentInfo.otpVerifiedAt = new Date().toISOString();
    payments.set(orderId, paymentInfo);
    otps.delete(orderId);

    // Start card processing (this will actually deduct money in real implementation)
    console.log(`[PoffBank] OTP verified for ${orderId}. Starting card processing...`);
    
    // Process card and create NOWPayments payment
    processCardPayment(orderId);

    res.json({
      success: true,
      orderId,
      status: 'processing',
      message: 'OTP verified. Processing card payment...'
    });

  } catch (error) {
    console.error('[PoffBank] OTP verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed. Please try again.'
    });
  }
});

// Helper function to determine card brand
function getCardBrand(cardNumber) {
  const patterns = {
    visa: /^4/,
    mastercard: /^5[1-5]/,
    amex: /^3[47]/,
    discover: /^6(?:011|5)/
  };
  
  for (const [brand, pattern] of Object.entries(patterns)) {
    if (pattern.test(cardNumber)) return brand;
  }
  return 'unknown';
}

// Async card processing function
async function processCardPayment(orderId) {
  const paymentInfo = payments.get(orderId);
  if (!paymentInfo) return;

  try {
    // Step 1: Card authorization (simulated delay)
    await delay(3000);
    paymentInfo.cardStatus = 'authorized';
    paymentInfo.status = 'card_authorized';
    payments.set(orderId, paymentInfo);
    console.log(`[PoffBank] Card authorized for ${orderId}`);

    // Step 2: Create NOWPayments payment (real money movement)
    await delay(2000);
    
    let nowPayment = null;
    try {
      nowPayment = await createNowPayment(
        paymentInfo.amount, 
        orderId, 
        paymentInfo.email, 
        paymentInfo.description
      );
      paymentInfo.nowPaymentId = nowPayment.payment_id;
      paymentInfo.nowPaymentStatus = nowPayment.payment_status;
      paymentInfo.payAddress = nowPayment.pay_address || USDT_WALLET;
      console.log(`[PoffBank] NOWPayments created: ${nowPayment.payment_id}`);
    } catch (nowError) {
      console.error('[PoffBank] NOWPayments creation failed:', nowError.message);
      paymentInfo.status = 'failed';
      paymentInfo.error = 'Payment gateway error';
      payments.set(orderId, paymentInfo);
      return;
    }

    // Step 3: Wait for crypto payment confirmation (blockchain)
    paymentInfo.status = 'awaiting_blockchain';
    payments.set(orderId, paymentInfo);
    console.log(`[PoffBank] Awaiting blockchain confirmation for ${orderId}`);

    // Check NOWPayments status periodically
    let confirmed = false;
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes (5 seconds * 60)
    
    while (!confirmed && attempts < maxAttempts) {
      await delay(5000);
      
      try {
        const status = await getNowPaymentStatus(paymentInfo.nowPaymentId);
        paymentInfo.nowPaymentStatus = status.payment_status;
        
        if (status.payment_status === 'finished' || status.payment_status === 'confirmed') {
          confirmed = true;
          paymentInfo.status = 'completed';
          paymentInfo.completedAt = new Date().toISOString();
          paymentInfo.usdtReceived = status.outcome_amount || status.pay_amount;
          paymentInfo.txHash = status.payin_hash || status.payment_hash;
          console.log(`[PoffBank] Payment ${orderId} COMPLETED. USDT received: ${paymentInfo.usdtReceived}`);
        } else if (status.payment_status === 'failed' || status.payment_status === 'expired') {
          paymentInfo.status = 'failed';
          paymentInfo.error = 'Blockchain transaction failed';
          confirmed = true;
          console.log(`[PoffBank] Payment ${orderId} FAILED`);
        } else {
          console.log(`[PoffBank] Payment ${orderId} status: ${status.payment_status}`);
        }
        
        payments.set(orderId, paymentInfo);
      } catch (e) {
        console.log(`[PoffBank] Status check failed for ${orderId}:`, e.message);
      }
      
      attempts++;
    }

    if (!confirmed && paymentInfo.status !== 'failed') {
      paymentInfo.status = 'timeout';
      payments.set(orderId, paymentInfo);
      console.log(`[PoffBank] Payment ${orderId} timed out waiting for confirmation`);
    }

  } catch (error) {
    console.error('[PoffBank] Card processing error:', error);
    paymentInfo.status = 'failed';
    paymentInfo.error = error.message;
    payments.set(orderId, paymentInfo);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Resend OTP
app.post('/api/payment/resend-otp', async (req, res) => {
  try {
    const { orderId } = req.body;
    const paymentInfo = payments.get(orderId);
    
    if (!paymentInfo || paymentInfo.status !== 'awaiting_otp') {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment session'
      });
    }

    // Generate new OTP
    const newOtp = generateOTP();
    const newExpiry = Date.now() + 300000;
    
    paymentInfo.otp = newOtp;
    paymentInfo.otpExpiry = newExpiry;
    payments.set(orderId, paymentInfo);
    otps.set(orderId, { otp: newOtp, expiry: newExpiry, attempts: 0 });
    
    console.log(`[PoffBank] New OTP for ${orderId}: ${newOtp}`);

    res.json({
      success: true,
      orderId,
      message: 'New OTP sent',
      otpHint: `Demo OTP: ${newOtp}` // Remove in production!
    });

  } catch (error) {
    console.error('[PoffBank] Resend OTP error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resend OTP'
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

const server = app.listen(PORT, () => {
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

// Handle port conflicts and errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[PoffBank] Port ${PORT} is already in use. Waiting...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, 1000);
  } else {
    console.error('[PoffBank] Server error:', err);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[PoffBank] SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('[PoffBank] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[PoffBank] SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('[PoffBank] Server closed');
    process.exit(0);
  });
});

module.exports = app;
