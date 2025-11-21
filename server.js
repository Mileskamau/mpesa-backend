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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'M-Pesa Backend is running!',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get access token
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
      CallBackURL: ` https://395c2f2f0c29.ngrok-free.app/mpesa-callback`,
      AccountReference: accountReference,
      TransactionDesc: 'Payment Test'
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

    res.json(stkResponse.data);
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to initiate payment',
      details: error.response?.data || error.message
    });
  }
});

// Callback endpoint
app.post('/mpesa-callback', (req, res) => {
  console.log('M-Pesa Callback:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ message: 'Callback received' });
});

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ 
      status: 'success', 
      message: 'Credentials are valid!' 
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: 'Invalid credentials' 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});