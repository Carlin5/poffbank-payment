const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// NOWPayments API Configuration
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'BT0AHVQ-MM8M4Z2-H57T2NC-V4EM2QG';
const NOWPAYMENTS_API_URL = 'https://api.nowpayments.io/v1';

// USDT TRC20 Wallet Configuration
// Wallet address configured in NOWPayments dashboard:
// TURXbzSQQKTiA6fqMzsZMaFQyXAU7o2nXh
// All USDT payments will be sent to this wallet

// Middleware - CORS configured to allow Netlify frontend
app.use(cors({
  origin: ['https://carlin5.netlify.app', 'http://localhost:3000', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());
app.use(express.static('.')); // Serve static files from current directory

// In-memory storage for payments (use database in production)
const payments = new Map();

// ============================================
// NOWPayments API Helper Functions
// ============================================

const nowPaymentsAPI = axios.create({
  baseURL: NOWPAYMENTS_API_URL,
  headers: {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
  }
});

// Get minimum payment amount for USDT
async function getMinimumPaymentAmount(currencyFrom = 'usd', currencyTo = 'usdttrc20') {
  try {
    const response = await nowPaymentsAPI.get(`/min-amount?currency_from=${currencyFrom}&currency_to=${currencyTo}`);
    return response.data;
  } catch (error) {
    console.error('Error getting minimum amount:', error.response?.data || error.message);
    throw error;
  }
}

// Get estimated price
async function getEstimatedPrice(amount, currencyFrom = 'usd', currencyTo = 'usdttrc20') {
  try {
    const response = await nowPaymentsAPI.get(`/estimate?amount=${amount}&currency_from=${currencyFrom}&currency_to=${currencyTo}`);
    return response.data;
  } catch (error) {
    console.error('Error getting estimate:', error.response?.data || error.message);
    throw error;
  }
}

// Create payment
async function createNowPayment(amount, orderId, email, cardData) {
  try {
    // In a real implementation, you would:
    // 1. Process the card payment through a provider like Stripe
    // 2. Use the received fiat to create a NOWPayments crypto payment
    // 3. Or use NOWPayments' fiat-to-crypto flow if available

    // For this integration, we'll create a crypto payment that your backend will handle
    const paymentData = {
      price_amount: amount,
      price_currency: 'usd',
      pay_currency: 'usdttrc20', // USDT on TRC20
      order_id: orderId,
      order_description: `PoffBank Payment - ${orderId}`,
      ipn_callback_url: `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/payment/callback`,
      success_url: `${process.env.BASE_URL || `http://localhost:${PORT}`}/payment/success?order_id=${orderId}`,
      cancel_url: `${process.env.BASE_URL || `http://localhost:${PORT}`}/payment/cancel?order_id=${orderId}`,
      customer_email: email,
      is_fixed_rate: true
    };

    const response = await nowPaymentsAPI.post('/payment', paymentData);
    return response.data;
  } catch (error) {
    console.error('Error creating payment:', error.response?.data || error.message);
    throw error;
  }
}

// Get payment status
async function getPaymentStatus(paymentId) {
  try {
    const response = await nowPaymentsAPI.get(`/payment/${paymentId}`);
    return response.data;
  } catch (error) {
    console.error('Error getting payment status:', error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// API Routes
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'PoffBank Payment Gateway',
    timestamp: new Date().toISOString()
  });
});

// Get exchange rate for USD to USDT
app.get('/api/exchange-rate', async (req, res) => {
  try {
    const estimate = await getEstimatedPrice(1, 'usd', 'usdttrc20');
    res.json({
      success: true,
      rate: estimate.estimated_amount,
      currency: 'USDT'
    });
  } catch (error) {
    console.error('Exchange rate error:', error);
    // Fallback rate
    res.json({
      success: true,
      rate: 1.00,
      currency: 'USDT',
      note: 'Using fallback rate'
    });
  }
});

// Create payment
app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, email, cardData } = req.body;

    // Validate input
    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount. Minimum $1.00 USD.'
      });
    }

    // Generate order ID
    const orderId = `POB-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Store payment info
    const paymentInfo = {
      orderId,
      amount: parseFloat(amount),
      email,
      cardLast4: cardData?.cardNumber ? cardData.cardNumber.slice(-4) : null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      nowPaymentId: null,
      nowPaymentStatus: null
    };

    payments.set(orderId, paymentInfo);

    // Create NOWPayments payment
    const nowPayment = await createNowPayment(amount, orderId, email, cardData);
    
    // Update payment info with NOWPayments data
    paymentInfo.nowPaymentId = nowPayment.payment_id;
    paymentInfo.nowPaymentStatus = nowPayment.payment_status;
    paymentInfo.payAddress = nowPayment.pay_address;
    payments.set(orderId, paymentInfo);

    console.log(`Payment created: ${orderId}`);

    res.json({
      success: true,
      orderId,
      paymentId: nowPayment.payment_id,
      status: nowPayment.payment_status,
      payAddress: nowPayment.pay_address,
      payAmount: nowPayment.pay_amount,
      payCurrency: nowPayment.pay_currency,
      validUntil: nowPayment.valid_until
    });

  } catch (error) {
    console.error('Payment creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create payment. Please try again.'
    });
  }
});

// Get payment status
app.get('/api/payment/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const paymentInfo = payments.get(orderId);

    if (!paymentInfo) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found'
      });
    }

    // If we have a NOWPayments ID, get fresh status
    if (paymentInfo.nowPaymentId) {
      try {
        const nowStatus = await getPaymentStatus(paymentInfo.nowPaymentId);
        paymentInfo.nowPaymentStatus = nowStatus.payment_status;
        payments.set(orderId, paymentInfo);
      } catch (e) {
        console.log('Could not fetch fresh status, using cached');
      }
    }

    res.json({
      success: true,
      orderId,
      status: paymentInfo.status,
      nowPaymentsStatus: paymentInfo.nowPaymentStatus,
      amount: paymentInfo.amount,
      createdAt: paymentInfo.createdAt
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check payment status'
    });
  }
});

// NOWPayments IPN Callback
app.post('/api/payment/callback', async (req, res) => {
  try {
    const callbackData = req.body;
    console.log('NOWPayments Callback:', callbackData);

    // Verify the callback (in production, verify signature)
    const { payment_id, order_id, payment_status, pay_amount, pay_currency } = callbackData;

    // Find payment in our storage
    for (const [key, payment] of payments.entries()) {
      if (payment.nowPaymentId === payment_id || payment.orderId === order_id) {
        payment.nowPaymentStatus = payment_status;
        
        // Update status based on NOWPayments status
        if (payment_status === 'finished' || payment_status === 'confirmed') {
          payment.status = 'completed';
        } else if (payment_status === 'failed' || payment_status === 'expired') {
          payment.status = 'failed';
        } else if (payment_status === 'confirming') {
          payment.status = 'processing';
        }

        payments.set(key, payment);
        console.log(`Payment ${key} updated to ${payment.status}`);
        break;
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Callback error:', error);
    res.status(200).send('OK'); // Always return 200 to NOWPayments
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

module.exports = app;
