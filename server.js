const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Only load dotenv in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Sandbox Constants
const SANDBOX_SHORTCODE = process.env.BUSINESS_SHORTCODE || '174379';
const SANDBOX_PASSKEY = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

// Get base URL for callbacks
function getCallbackUrl() {
  // Use your actual Railway URL
  return 'https://mpesa-backend-production-10ca.up.railway.app/mpesa-callback';
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'M-Pesa Backend is running!',
    callbackUrl: getCallbackUrl(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get M-Pesa access token
async function getAccessToken() {
  try {
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    
    const response = await axios.get(
      `${SANDBOX_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    throw error;
  }
}

// Generate timestamp
function generateTimestamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
}

// STK Push endpoint
app.post('/initiate-payment', async (req, res) => {
  try {
    const { phone, amount, accountReference } = req.body;
    
    console.log('Initiating payment for:', phone, amount);
    
    const accessToken = await getAccessToken();
    const timestamp = generateTimestamp();
    
    const password = Buffer.from(
      `${SANDBOX_SHORTCODE}${SANDBOX_PASSKEY}${timestamp}`
    ).toString('base64');

    const callbackUrl = getCallbackUrl();
    console.log('Using callback URL:', callbackUrl);

    const stkPayload = {
      BusinessShortCode: SANDBOX_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: SANDBOX_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: callbackUrl, // Use the fixed callback URL
      AccountReference: accountReference,
      TransactionDesc: 'Payment Test'
    };

    console.log('Sending STK request to M-Pesa...');
    
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

    console.log('M-Pesa response:', stkResponse.data);
    res.json(stkResponse.data);
    
  } catch (error) {
    console.error('Payment initiation error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// Callback endpoint - M-Pesa will call this
app.post('/mpesa-callback', (req, res) => {
  console.log('✅ M-Pesa Callback Received!');
  console.log('Callback data:', JSON.stringify(req.body, null, 2));
  
  // Process the callback
  const callbackData = req.body;
  
  if (callbackData.Body && callbackData.Body.stkCallback && callbackData.Body.stkCallback.ResultCode === 0) {
    console.log('🎉 Payment was successful!');
    // Here you would update your database
  } else {
    console.log('❌ Payment failed:', callbackData.Body?.stkCallback?.ResultDesc);
  }
  
  // Always return success to M-Pesa
  res.status(200).json({ 
    ResultCode: 0, 
    ResultDesc: "Success" 
  });
});

// Test endpoint to verify callback URL is accessible
app.get('/test-callback', (req, res) => {
  res.json({ 
    message: 'Callback endpoint is accessible',
    url: getCallbackUrl(),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Callback URL: ${getCallbackUrl()}`);
});