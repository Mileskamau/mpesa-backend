const express = require('express');
const axios = require('axios');
const cors = require('cors');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage (will reset on server restart)
const paymentStatus = new Map();

// Sandbox Constants
const SANDBOX_SHORTCODE = process.env.BUSINESS_SHORTCODE || '6944256';
const SANDBOX_PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

function getCallbackUrl() {
  return 'https://mpesa-backend-production-10ca.up.railway.app/mpesa-callback';
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'M-Pesa Backend is running! 🚀',
    storage: 'in-memory',
    firebase: 'disabled',
    timestamp: new Date().toISOString()
  });
});

// Get access token
async function getAccessToken() {
  try {
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get(
      `${SANDBOX_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('Access token error:', error.response?.data || error.message);
    throw error;
  }
}

function generateTimestamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
}

// STK Push endpoint
app.post('/initiate-payment', async (req, res) => {
  try {
    const { phone, amount, accountReference, eventId, userId } = req.body;
    
    console.log('💰 Initiating payment:', { phone, amount, accountReference, eventId, userId });
    
    const accessToken = await getAccessToken();
    const timestamp = generateTimestamp();
    
    const password = Buffer.from(
      `${SANDBOX_SHORTCODE}${SANDBOX_PASSKEY}${timestamp}`
    ).toString('base64');

    const stkPayload = {
      BusinessShortCode: SANDBOX_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: SANDBOX_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: getCallbackUrl(),
      AccountReference: accountReference,
      TransactionDesc: 'Payment'
    };

    const stkResponse = await axios.post(
      `${SANDBOX_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      stkPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Store payment in memory
    if (stkResponse.data.CheckoutRequestID) {
      const paymentData = {
        checkoutRequestID: stkResponse.data.CheckoutRequestID,
        merchantRequestID: stkResponse.data.MerchantRequestID,
        phone: phone,
        amount: amount,
        accountReference: accountReference,
        eventId: eventId || '',
        userId: userId || '',
        status: 'pending',
        initiatedAt: new Date().toISOString(),
        mpesaResponse: stkResponse.data
      };
      
      paymentStatus.set(stkResponse.data.CheckoutRequestID, paymentData);
      console.log('✅ Payment stored in memory:', stkResponse.data.CheckoutRequestID);
    }

    // Return both the M-Pesa response and our transaction ID
    res.json({
      ...stkResponse.data,
      transactionId: stkResponse.data.CheckoutRequestID,
      success: true
    });
    
  } catch (error) {
    console.error('Payment initiation error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// NEW: Payment status endpoint for Flutter app polling
app.get('/payment-status/:transactionId', (req, res) => {
  try {
    const { transactionId } = req.params;
    
    console.log('🔍 Checking payment status for:', transactionId);
    
    if (paymentStatus.has(transactionId)) {
      const payment = paymentStatus.get(transactionId);
      
      let status, message;
      
      switch (payment.status) {
        case 'success':
          status = 'completed';
          message = 'Payment completed successfully';
          break;
        case 'failed':
          status = 'failed';
          message = payment.error || 'Payment failed or was cancelled';
          break;
        case 'pending':
        default:
          status = 'pending';
          message = 'Payment is pending';
      }
      
      res.json({
        status: status,
        success: payment.status === 'success',
        message: message,
        transactionId: transactionId,
        payment: payment
      });
      
    } else {
      res.status(404).json({
        status: 'not_found',
        success: false,
        message: 'Transaction not found'
      });
    }
  } catch (error) {
    console.error('Payment status error:', error);
    res.status(500).json({
      status: 'error',
      success: false,
      message: 'Failed to fetch payment status'
    });
  }
});

// Callback endpoint - M-Pesa will call this
app.post('/mpesa-callback', (req, res) => {
  console.log('📞 M-Pesa Callback Received');
  
  try {
    const callbackData = req.body;
    const stkCallback = callbackData.Body?.stkCallback;
    
    if (stkCallback) {
      const checkoutRequestID = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      const resultDesc = stkCallback.ResultDesc;
      
      console.log('Processing callback for:', checkoutRequestID);
      console.log('Result:', resultCode, '-', resultDesc);

      // Update payment status
      if (paymentStatus.has(checkoutRequestID)) {
        const payment = paymentStatus.get(checkoutRequestID);
        
        if (resultCode === 0) {
          // Payment successful
          payment.status = 'success';
          payment.completedAt = new Date().toISOString();
          
          // Extract transaction details
          const callbackMetadata = stkCallback.CallbackMetadata;
          if (callbackMetadata && callbackMetadata.Item) {
            callbackMetadata.Item.forEach(item => {
              if (item.Name === 'Amount') payment.amount = item.Value;
              if (item.Name === 'MpesaReceiptNumber') payment.mpesaReceiptNumber = item.Value;
              if (item.Name === 'TransactionDate') payment.transactionDate = item.Value;
              if (item.Name === 'PhoneNumber') payment.phone = item.Value;
            });
          }
          
          console.log('🎉 PAYMENT SUCCESSFUL - Receipt:', payment.mpesaReceiptNumber);
          
          // Log successful payment (would save to Firebase here)
          console.log('💾 SUCCESSFUL PAYMENT DATA:', {
            receipt: payment.mpesaReceiptNumber,
            amount: payment.amount,
            phone: payment.phone,
            accountReference: payment.accountReference,
            eventId: payment.eventId,
            userId: payment.userId,
            timestamp: payment.completedAt
          });
          
          // TODO: Here you would update your database to register the user for the event
          // This is where you'd connect to Firebase to update the event participants
          console.log(`✅ USER ${payment.userId} SHOULD BE REGISTERED FOR EVENT ${payment.eventId}`);
          
        } else {
          // Payment failed
          payment.status = 'failed';
          payment.error = resultDesc;
          payment.completedAt = new Date().toISOString();
          console.log('❌ PAYMENT FAILED:', resultDesc);
        }
        
        paymentStatus.set(checkoutRequestID, payment);
      } else {
        console.log('⚠️ Payment not found in memory:', checkoutRequestID);
      }
    }

    // Always respond successfully to M-Pesa
    res.json({
      ResultCode: 0,
      ResultDesc: "Success"
    });

  } catch (error) {
    console.error('Error processing callback:', error);
    res.json({
      ResultCode: 0,
      ResultDesc: "Success"
    });
  }
});

// Get payment details by checkoutRequestID
app.get('/payment/:checkoutRequestID', (req, res) => {
  try {
    const { checkoutRequestID } = req.params;
    
    if (paymentStatus.has(checkoutRequestID)) {
      const payment = paymentStatus.get(checkoutRequestID);
      res.json({
        status: 'found',
        payment: payment
      });
    } else {
      res.status(404).json({
        status: 'not_found',
        message: 'Payment not found'
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch payment'
    });
  }
});

// Get all payments
app.get('/payments', (req, res) => {
  try {
    const payments = Array.from(paymentStatus.entries()).map(([id, data]) => ({
      checkoutRequestID: id,
      ...data
    }));
    
    res.json({
      total: payments.length,
      payments: payments
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch payments'
    });
  }
});

// Get payment statistics
app.get('/stats', (req, res) => {
  try {
    const payments = Array.from(paymentStatus.values());
    
    const stats = {
      total: payments.length,
      successful: payments.filter(p => p.status === 'success').length,
      failed: payments.filter(p => p.status === 'failed').length,
      pending: payments.filter(p => p.status === 'pending').length,
      totalAmount: payments.filter(p => p.status === 'success').reduce((sum, p) => sum + (p.amount || 0), 0)
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch statistics'
    });
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({ 
    message: 'Test successful!',
    server: 'running',
    firebase: 'not-connected',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Callback URL: ${getCallbackUrl()}`);
  console.log(`💾 Storage: In-memory (Firebase disabled)`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔍 Payment Status Endpoint: GET /payment-status/:transactionId`);
});