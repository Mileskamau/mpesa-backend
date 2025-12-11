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
const paypalPayments = new Map(); // New storage for PayPal payments

// Sandbox Constants
const SANDBOX_SHORTCODE = process.env.BUSINESS_SHORTCODE || '6944256';
const SANDBOX_PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

// PayPal Configuration
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || '';
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || ''; // For production

function getCallbackUrl() {
  return 'https://mpesa-backend-production-10ca.up.railway.app/mpesa-callback';
}

function getPaypalReturnUrl() {
  return 'https://your-app.com/paypal/success';
}

function getPaypalCancelUrl() {
  return 'https://your-app.com/paypal/cancel';
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Payment Backend is running! 🚀',
    services: {
      mpesa: 'active',
      paypal: 'active',
      storage: 'in-memory'
    },
    timestamp: new Date().toISOString()
  });
});

// ================== M-PESA FUNCTIONS ==================

// Get M-Pesa access token
async function getMpesaAccessToken() {
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

// ================== PAYPAL FUNCTIONS ==================

// Get PayPal access token
async function getPaypalAccessToken() {
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`,
        }
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('PayPal access token error:', error.response?.data || error.message);
    throw error;
  }
}

// Create PayPal order
async function createPaypalOrder(orderData) {
  try {
    const accessToken = await getPaypalAccessToken();
    
    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v2/checkout/orders`,
      orderData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'PayPal-Request-Id': orderData.purchase_units[0].custom_id,
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('PayPal order creation error:', error.response?.data || error.message);
    throw error;
  }
}

// Capture PayPal payment
async function capturePaypalPayment(orderId) {
  try {
    const accessToken = await getPaypalAccessToken();
    
    const response = await axios.post(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'Prefer': 'return=representation',
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('PayPal capture error:', error.response?.data || error.message);
    throw error;
  }
}

// Get PayPal order details
async function getPaypalOrder(orderId) {
  try {
    const accessToken = await getPaypalAccessToken();
    
    const response = await axios.get(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('PayPal get order error:', error.response?.data || error.message);
    throw error;
  }
}

// ================== M-PESA ENDPOINTS ==================

// STK Push endpoint
app.post('/initiate-payment', async (req, res) => {
  try {
    const { phone, amount, accountReference, eventId, userId } = req.body;
    
    console.log('💰 Initiating M-Pesa payment:', { phone, amount, accountReference, eventId, userId });
    
    const accessToken = await getMpesaAccessToken();
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
        type: 'mpesa',
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
      console.log('✅ M-Pesa payment stored in memory:', stkResponse.data.CheckoutRequestID);
    }

    // Return both the M-Pesa response and our transaction ID
    res.json({
      ...stkResponse.data,
      transactionId: stkResponse.data.CheckoutRequestID,
      success: true
    });
    
  } catch (error) {
    console.error('M-Pesa payment initiation error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate M-Pesa payment',
      details: error.response?.data || error.message
    });
  }
});

// ================== PAYPAL ENDPOINTS ==================

// Create PayPal order endpoint
// Create PayPal order endpoint - UPDATED
app.post('/create-paypal-order', async (req, res) => {
  try {
    const { 
      amount, 
      eventId, 
      userId, 
      username, 
      email,
      selectedTeam 
    } = req.body;
    
    console.log('💰 Creating PayPal order for:', { 
      amount, 
      eventId, 
      userId, 
      email 
    });
    
    // Convert KES to USD
    const usdAmount = (parseFloat(amount) / 130).toFixed(2);
    const transactionId = `PP${eventId}_${userId}_${Date.now()}`;
    
    const orderData = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: transactionId,
          description: `PUBG Event: ${eventId}`,
          amount: {
            currency_code: 'USD',
            value: usdAmount
          },
          custom_id: transactionId
        }
      ],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            brand_name: 'PUBG Events',
            locale: 'en-US',
            landing_page: 'LOGIN',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: getPaypalReturnUrl(),
            cancel_url: getPaypalCancelUrl()
          }
        }
      }
    };
    
    const order = await createPaypalOrder(orderData);
    
    // Store PayPal payment in memory
    const paymentData = {
      type: 'paypal',
      orderId: order.id,
      transactionId: transactionId,
      amount: amount,
      usdAmount: usdAmount,
      currency: 'USD',
      eventId: eventId || '',
      userId: userId || '',
      username: username || '',
      email: email || '',
      selectedTeam: selectedTeam || null,
      status: 'created',
      created_at: new Date().toISOString(),
      paypalResponse: order
    };
    
    paypalPayments.set(order.id, paymentData);
    console.log('✅ PayPal payment stored:', order.id);
    
    // Find approval URL - FIXED LOGIC
    let approvalUrl = '';
    console.log('Order links:', order.links);
    
    if (order.links && Array.isArray(order.links)) {
      // Try to find payer-action link first
      const payerActionLink = order.links.find(link => link.rel === 'payer-action');
      if (payerActionLink) {
        approvalUrl = payerActionLink.href;
        console.log('Found payer-action link:', approvalUrl);
      } else {
        // Fallback to approve link
        const approveLink = order.links.find(link => link.rel === 'approve');
        if (approveLink) {
          approvalUrl = approveLink.href;
          console.log('Found approve link:', approvalUrl);
        } else {
          // If no specific link, use the first one that's not self
          const otherLink = order.links.find(link => link.rel !== 'self');
          if (otherLink) {
            approvalUrl = otherLink.href;
            console.log('Found other link:', approvalUrl);
          }
        }
      }
    }
    
    // Also try to extract from payment_source if available
    if (!approvalUrl && order.payment_source?.paypal?.links) {
      const paypalLink = order.payment_source.paypal.links.find(link => link.rel === 'approve');
      if (paypalLink) {
        approvalUrl = paypalLink.href;
      }
    }
    
    // If still no URL, construct a default PayPal checkout URL
    if (!approvalUrl && order.id) {
      approvalUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`;
      console.log('Constructed default approval URL:', approvalUrl);
    }
    
    if (!approvalUrl) {
      console.error('❌ Could not find or construct approval URL');
      throw new Error('No approval URL available');
    }
    
    res.json({
      success: true,
      orderId: order.id,
      transactionId: transactionId,
      approvalUrl: approvalUrl,
      status: order.status,
      links: order.links, // Include links for debugging
      message: 'PayPal order created successfully'
    });
    
  } catch (error) {
    console.error('❌ Error creating PayPal order:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to create PayPal order',
      details: error.response?.data || error.message,
      debug: {
        paypalClientId: PAYPAL_CLIENT_ID ? 'Set' : 'Not set',
        paypalBaseUrl: PAYPAL_BASE_URL
      }
    });
  }
});

// Capture PayPal payment endpoint
app.post('/capture-paypal-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    
    console.log('💳 Capturing PayPal order:', orderId);
    
    if (!paypalPayments.has(orderId)) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    const captureResult = await capturePaypalPayment(orderId);
    
    // Update payment status
    const payment = paypalPayments.get(orderId);
    payment.status = captureResult.status === 'COMPLETED' ? 'completed' : 'captured';
    payment.captured_at = new Date().toISOString();
    payment.captureResponse = captureResult;
    
    paypalPayments.set(orderId, payment);
    
    console.log('✅ PayPal payment captured:', orderId, 'Status:', payment.status);
    
    // Log successful payment
    console.log('💾 PAYPAL PAYMENT COMPLETED:', {
      orderId: orderId,
      transactionId: payment.transactionId,
      amount: payment.amount,
      usdAmount: payment.usdAmount,
      email: payment.email,
      eventId: payment.eventId,
      userId: payment.userId,
      timestamp: payment.captured_at
    });
    
    // TODO: Here you would update your database to register the user for the event
    console.log(`✅ USER ${payment.userId} SHOULD BE REGISTERED FOR EVENT ${payment.eventId} VIA PAYPAL`);
    
    res.json({
      success: true,
      status: payment.status,
      orderId: orderId,
      transactionId: payment.transactionId,
      capture: captureResult
    });
    
  } catch (error) {
    console.error('PayPal capture error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to capture PayPal payment',
      details: error.response?.data || error.message
    });
  }
});

// Check PayPal payment status endpoint
app.get('/paypal-payment-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    console.log('🔍 Checking PayPal payment status for:', orderId);
    
    if (paypalPayments.has(orderId)) {
      const payment = paypalPayments.get(orderId);
      
      // If payment is not completed, check with PayPal API
      if (payment.status !== 'completed') {
        try {
          const orderDetails = await getPaypalOrder(orderId);
          const paypalStatus = orderDetails.status;
          
          // Update status based on PayPal response
          if (paypalStatus === 'COMPLETED' || paypalStatus === 'APPROVED') {
            payment.status = 'completed';
            payment.captured_at = new Date().toISOString();
            payment.paypalResponse = orderDetails;
            paypalPayments.set(orderId, payment);
            
            console.log(`✅ PayPal payment ${orderId} is completed`);
          } else if (paypalStatus === 'FAILED' || paypalStatus === 'CANCELLED') {
            payment.status = 'failed';
            payment.failed_at = new Date().toISOString();
            paypalPayments.set(orderId, payment);
          }
        } catch (apiError) {
          console.error('Error checking PayPal API:', apiError.message);
        }
      }
      
      res.json({
        success: payment.status === 'completed',
        status: payment.status,
        orderId: orderId,
        transactionId: payment.transactionId,
        payment: payment
      });
      
    } else {
      res.status(404).json({
        success: false,
        status: 'not_found',
        message: 'PayPal order not found'
      });
    }
  } catch (error) {
    console.error('PayPal status check error:', error);
    res.status(500).json({
      success: false,
      status: 'error',
      message: 'Failed to fetch PayPal payment status'
    });
  }
});

// ================== SHARED ENDPOINTS ==================

// Payment status endpoint for Flutter app polling (supports both M-Pesa and PayPal)
app.get('/payment-status/:transactionId', (req, res) => {
  try {
    const { transactionId } = req.params;
    
    console.log('🔍 Checking payment status for:', transactionId);
    
    // Check M-Pesa payments first
    if (paymentStatus.has(transactionId)) {
      const payment = paymentStatus.get(transactionId);
      
      let status, message;
      
      switch (payment.status) {
        case 'success':
          status = 'completed';
          message = 'M-Pesa payment completed successfully';
          break;
        case 'failed':
          status = 'failed';
          message = payment.error || 'M-Pesa payment failed or was cancelled';
          break;
        case 'pending':
        default:
          status = 'pending';
          message = 'M-Pesa payment is pending';
      }
      
      res.json({
        type: 'mpesa',
        status: status,
        success: payment.status === 'success',
        message: message,
        transactionId: transactionId,
        payment: payment
      });
      
    } 
    // Check PayPal payments
    else {
      // Check if it's a PayPal order ID
      const paypalPayment = Array.from(paypalPayments.values()).find(
        payment => payment.orderId === transactionId || payment.transactionId === transactionId
      );
      
      if (paypalPayment) {
        res.json({
          type: 'paypal',
          status: paypalPayment.status,
          success: paypalPayment.status === 'completed',
          message: `PayPal payment is ${paypalPayment.status}`,
          transactionId: transactionId,
          orderId: paypalPayment.orderId,
          payment: paypalPayment
        });
      } else {
        res.status(404).json({
          type: 'unknown',
          status: 'not_found',
          success: false,
          message: 'Transaction not found'
        });
      }
    }
  } catch (error) {
    console.error('Payment status error:', error);
    res.status(500).json({
      type: 'error',
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
      
      console.log('Processing M-Pesa callback for:', checkoutRequestID);
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
          
          console.log('🎉 M-PESA PAYMENT SUCCESSFUL - Receipt:', payment.mpesaReceiptNumber);
          
          // Log successful payment
          console.log('💾 M-PESA PAYMENT DATA:', {
            receipt: payment.mpesaReceiptNumber,
            amount: payment.amount,
            phone: payment.phone,
            accountReference: payment.accountReference,
            eventId: payment.eventId,
            userId: payment.userId,
            timestamp: payment.completedAt
          });
          
          console.log(`✅ USER ${payment.userId} SHOULD BE REGISTERED FOR EVENT ${payment.eventId}`);
          
        } else {
          // Payment failed
          payment.status = 'failed';
          payment.error = resultDesc;
          payment.completedAt = new Date().toISOString();
          console.log('❌ M-PESA PAYMENT FAILED:', resultDesc);
        }
        
        paymentStatus.set(checkoutRequestID, payment);
      } else {
        console.log('⚠️ M-Pesa payment not found in memory:', checkoutRequestID);
      }
    }

    // Always respond successfully to M-Pesa
    res.json({
      ResultCode: 0,
      ResultDesc: "Success"
    });

  } catch (error) {
    console.error('Error processing M-Pesa callback:', error);
    res.json({
      ResultCode: 0,
      ResultDesc: "Success"
    });
  }
});

// PayPal webhook endpoint (for production)
app.post('/paypal-webhook', async (req, res) => {
  console.log('📞 PayPal Webhook Received');
  
  try {
    const event = req.body;
    console.log('PayPal Webhook Event:', event.event_type);
    
    // Verify webhook signature (recommended for production)
    // const webhookId = PAYPAL_WEBHOOK_ID;
    // const transmissionId = req.headers['paypal-transmission-id'];
    // const timestamp = req.headers['paypal-transmission-time'];
    // const sig = req.headers['paypal-transmission-sig'];
    // const certUrl = req.headers['paypal-cert-url'];
    
    if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = event.resource.id;
      
      if (paypalPayments.has(orderId)) {
        const payment = paypalPayments.get(orderId);
        payment.status = 'approved';
        payment.approved_at = new Date().toISOString();
        paypalPayments.set(orderId, payment);
        
        console.log(`✅ PayPal order approved: ${orderId}`);
      }
    } 
    else if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = event.resource.supplementary_data.related_ids.order_id;
      
      if (paypalPayments.has(orderId)) {
        const payment = paypalPayments.get(orderId);
        payment.status = 'completed';
        payment.captured_at = new Date().toISOString();
        payment.captureId = event.resource.id;
        paypalPayments.set(orderId, payment);
        
        console.log(`🎉 PayPal payment completed: ${orderId}, Capture ID: ${event.resource.id}`);
        
        // TODO: Update database with successful payment
        console.log(`✅ USER ${payment.userId} REGISTERED FOR EVENT ${payment.eventId} VIA PAYPAL`);
      }
    }
    else if (event.event_type === 'PAYMENT.CAPTURE.DENIED' || 
             event.event_type === 'PAYMENT.CAPTURE.FAILED') {
      const orderId = event.resource.supplementary_data.related_ids.order_id;
      
      if (paypalPayments.has(orderId)) {
        const payment = paypalPayments.get(orderId);
        payment.status = 'failed';
        payment.failed_at = new Date().toISOString();
        payment.error = event.summary || 'Payment failed';
        paypalPayments.set(orderId, payment);
        
        console.log(`❌ PayPal payment failed: ${orderId}`);
      }
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error processing PayPal webhook:', error);
    res.status(500).send('Error');
  }
});

// Get payment details
app.get('/payment/:paymentId', (req, res) => {
  try {
    const { paymentId } = req.params;
    
    // Check M-Pesa payments
    if (paymentStatus.has(paymentId)) {
      const payment = paymentStatus.get(paymentId);
      res.json({
        type: 'mpesa',
        status: 'found',
        payment: payment
      });
    } 
    // Check PayPal payments
    else if (paypalPayments.has(paymentId)) {
      const payment = paypalPayments.get(paymentId);
      res.json({
        type: 'paypal',
        status: 'found',
        payment: payment
      });
    } else {
      res.status(404).json({
        type: 'unknown',
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

// Get all payments (both types)
app.get('/payments', (req, res) => {
  try {
    const mpesaPayments = Array.from(paymentStatus.entries()).map(([id, data]) => ({
      id: id,
      type: 'mpesa',
      ...data
    }));
    
    const paypalPaymentsList = Array.from(paypalPayments.entries()).map(([id, data]) => ({
      id: id,
      type: 'paypal',
      ...data
    }));
    
    const allPayments = [...mpesaPayments, ...paypalPaymentsList];
    
    res.json({
      total: allPayments.length,
      mpesa: mpesaPayments.length,
      paypal: paypalPaymentsList.length,
      payments: allPayments
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
    const mpesaPayments = Array.from(paymentStatus.values());
    const paypalPaymentsList = Array.from(paypalPayments.values());
    
    const stats = {
      total: mpesaPayments.length + paypalPaymentsList.length,
      mpesa: {
        total: mpesaPayments.length,
        successful: mpesaPayments.filter(p => p.status === 'success').length,
        failed: mpesaPayments.filter(p => p.status === 'failed').length,
        pending: mpesaPayments.filter(p => p.status === 'pending').length,
        totalAmount: mpesaPayments.filter(p => p.status === 'success').reduce((sum, p) => sum + (p.amount || 0), 0)
      },
      paypal: {
        total: paypalPaymentsList.length,
        completed: paypalPaymentsList.filter(p => p.status === 'completed').length,
        failed: paypalPaymentsList.filter(p => p.status === 'failed').length,
        pending: paypalPaymentsList.filter(p => p.status === 'created' || p.status === 'approved').length,
        totalAmountUSD: paypalPaymentsList.filter(p => p.status === 'completed').reduce((sum, p) => sum + parseFloat(p.usdAmount || 0), 0).toFixed(2)
      }
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
    services: {
      mpesa: 'active',
      paypal: 'active'
    },
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Services Available:`);
  console.log(`   • M-Pesa Callback URL: ${getCallbackUrl()}`);
  console.log(`   • PayPal Return URL: ${getPaypalReturnUrl()}`);
  console.log(`   • PayPal Cancel URL: ${getPaypalCancelUrl()}`);
  console.log(`💾 Storage: In-memory`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔍 Endpoints:`);
  console.log(`   • M-Pesa: POST /initiate-payment`);
  console.log(`   • PayPal: POST /create-paypal-order`);
  console.log(`   • PayPal: POST /capture-paypal-order`);
  console.log(`   • Status: GET /payment-status/:transactionId`);
  console.log(`   • PayPal Status: GET /paypal-payment-status/:orderId`);
});