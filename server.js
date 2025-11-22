const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

// Only load dotenv in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Initialize Firebase Admin
try {
  // For Railway deployment, use environment variables
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Parse service account from environment variable
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    // For local development, use the JSON file
    const serviceAccount = require('./firebase-service-account.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  console.log('✅ Firebase initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization error:', error);
}

const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Sandbox Constants
const SANDBOX_SHORTCODE = process.env.BUSINESS_SHORTCODE || '174379';
const SANDBOX_PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

function getCallbackUrl() {
  return 'https://mpesa-backend-production-10ca.up.railway.app/mpesa-callback';
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'M-Pesa Backend is running!',
    firebase: 'connected',
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
    throw error;
  }
}

function generateTimestamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
}

// Save payment to Firebase
async function savePaymentToFirebase(paymentData) {
  try {
    const paymentRef = db.collection('mpesa_payments').doc();
    
    const paymentRecord = {
      id: paymentRef.id,
      ...paymentData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await paymentRef.set(paymentRecord);
    
    console.log('✅ Payment saved to Firebase:', paymentRef.id);
    return paymentRecord;
  } catch (error) {
    console.error('❌ Error saving to Firebase:', error);
    throw error;
  }
}

// Update payment in Firebase
async function updatePaymentInFirebase(checkoutRequestID, updates) {
  try {
    const paymentsRef = db.collection('mpesa_payments');
    const snapshot = await paymentsRef.where('checkoutRequestID', '==', checkoutRequestID).get();
    
    if (snapshot.empty) {
      console.log('❌ Payment not found in Firebase:', checkoutRequestID);
      return null;
    }
    
    const doc = snapshot.docs[0];
    await doc.ref.update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log('✅ Payment updated in Firebase:', checkoutRequestID);
    return doc.id;
  } catch (error) {
    console.error('❌ Error updating payment in Firebase:', error);
    throw error;
  }
}

// STK Push endpoint
app.post('/initiate-payment', async (req, res) => {
  try {
    const { phone, amount, accountReference, customerName, customerEmail } = req.body;
    
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

    // Save initial payment record to Firebase
    if (stkResponse.data.CheckoutRequestID) {
      const paymentData = {
        checkoutRequestID: stkResponse.data.CheckoutRequestID,
        merchantRequestID: stkResponse.data.MerchantRequestID,
        phone: phone,
        amount: amount,
        accountReference: accountReference,
        customerName: customerName || '',
        customerEmail: customerEmail || '',
        status: 'pending',
        initiatedAt: new Date().toISOString(),
        mpesaResponse: stkResponse.data
      };
      
      await savePaymentToFirebase(paymentData);
    }

    res.json(stkResponse.data);
    
  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// Enhanced Callback endpoint with Firebase
app.post('/mpesa-callback', async (req, res) => {
  console.log('📞 M-Pesa Callback Received');
  
  try {
    const callbackData = req.body;
    console.log('Callback data received');

    const stkCallback = callbackData.Body?.stkCallback;
    
    if (stkCallback) {
      const checkoutRequestID = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      const resultDesc = stkCallback.ResultDesc;
      
      console.log('Processing callback for:', checkoutRequestID);
      console.log('Result Code:', resultCode);
      console.log('Result Description:', resultDesc);

      // Prepare update data
      const updateData = {
        callbackData: callbackData,
        resultCode: resultCode,
        resultDesc: resultDesc,
        completedAt: new Date().toISOString()
      };

      if (resultCode === 0) {
        // Payment successful
        updateData.status = 'success';
        
        // Extract transaction details
        const callbackMetadata = stkCallback.CallbackMetadata;
        if (callbackMetadata && callbackMetadata.Item) {
          callbackMetadata.Item.forEach(item => {
            if (item.Name === 'Amount') updateData.amount = item.Value;
            if (item.Name === 'MpesaReceiptNumber') updateData.mpesaReceiptNumber = item.Value;
            if (item.Name === 'TransactionDate') updateData.transactionDate = item.Value;
            if (item.Name === 'PhoneNumber') updateData.phone = item.Value;
          });
        }
        
        console.log('✅ PAYMENT SUCCESSFUL - Saving to Firebase');
        
      } else {
        // Payment failed
        updateData.status = 'failed';
        updateData.error = resultDesc;
        console.log('❌ PAYMENT FAILED - Updating Firebase');
      }

      // Update payment in Firebase
      await updatePaymentInFirebase(checkoutRequestID, updateData);
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

// Get payment by checkoutRequestID
app.get('/payment/:checkoutRequestID', async (req, res) => {
  try {
    const { checkoutRequestID } = req.params;
    
    const paymentsRef = db.collection('mpesa_payments');
    const snapshot = await paymentsRef.where('checkoutRequestID', '==', checkoutRequestID).get();
    
    if (snapshot.empty) {
      return res.status(404).json({
        status: 'not_found',
        message: 'Payment not found'
      });
    }
    
    const payment = snapshot.docs[0].data();
    res.json({
      status: 'found',
      payment: payment
    });
    
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({
      error: 'Failed to fetch payment'
    });
  }
});

// Get all payments (with optional filtering)
app.get('/payments', async (req, res) => {
  try {
    const { status, phone, limit = 50 } = req.query;
    
    let query = db.collection('mpesa_payments').orderBy('createdAt', 'desc').limit(parseInt(limit));
    
    // Apply filters
    if (status) {
      query = query.where('status', '==', status);
    }
    
    if (phone) {
      query = query.where('phone', '==', phone);
    }
    
    const snapshot = await query.get();
    const payments = snapshot.docs.map(doc => doc.data());
    
    res.json({
      total: payments.length,
      payments: payments
    });
    
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({
      error: 'Failed to fetch payments'
    });
  }
});

// Get payment statistics
app.get('/payment-stats', async (req, res) => {
  try {
    const paymentsRef = db.collection('mpesa_payments');
    
    // You might want to add more sophisticated analytics here
    const snapshot = await paymentsRef.get();
    const payments = snapshot.docs.map(doc => doc.data());
    
    const stats = {
      total: payments.length,
      successful: payments.filter(p => p.status === 'success').length,
      failed: payments.filter(p => p.status === 'failed').length,
      pending: payments.filter(p => p.status === 'pending').length,
      totalAmount: payments.filter(p => p.status === 'success').reduce((sum, p) => sum + (p.amount || 0), 0)
    };
    
    res.json(stats);
    
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Callback URL: ${getCallbackUrl()}`);
  console.log(`🔥 Firebase: ${admin.apps.length > 0 ? 'Connected' : 'Not connected'}`);
});