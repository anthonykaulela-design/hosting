require('dotenv').config();
const express = require('express');
const cors = require('cors');
const DomainNameApi = require('nodejs-dna');

const app = express();

// 1. CORS Configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Initialize Domain Name API Client
const resellerId = process.env.RESELLER_ID || '63ee50a9-2031-181a-df7b-3a23b6486daf';
const apiKey = process.env.API_KEY || 'yat7dN3z6ZEGzsBhm792sqUl6SPpBmU6NFMI1fyk';

const dnaClient = new DomainNameApi(resellerId, apiKey);

/**
 * Standardized Error Formatter
 * Converts complex SDK/API exceptions into simple, human-readable error messages.
 */
function handleApiError(res, error, defaultMessage) {
  console.error('API Error:', error);

  let cleanMessage = defaultMessage;

  if (typeof error === 'string') {
    cleanMessage = error;
  } else if (error && error.message) {
    cleanMessage = error.message;
  } else if (error && error.data && error.data.Message) {
    cleanMessage = error.data.Message;
  }

  return res.status(400).json({
    status: 'error',
    message: cleanMessage,
    timestamp: new Date().toISOString()
  });
}

// Health Check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'L3 Markets Domain API Proxy Server is active.'
  });
});

// ==========================================
// 1. SUBRESELLER MANAGEMENT (Stored in Domain API)
// ==========================================

/**
 * Add New Subreseller
 * Forwards all subreseller registration data directly to Domain Name API database.
 */
app.post('/api/subreseller/add', async (req, res) => {
  try {
    const {
      resellerName,
      firstName,
      lastName,
      address,
      companyName,
      city,
      state,
      owner,
      country,
      zipCode,
      phone,
      email,
      alternativeEmail,
      webLink,
      resellerGroup,
      username,
      password,
      confirmPassword
    } = req.body;

    // Basic Validation
    if (!username || !password || !email || !firstName || !lastName) {
      return res.status(400).json({
        status: 'error',
        message: 'Please fill in all required fields (Username, Password, Name, Email).'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        status: 'error',
        message: 'Password and Confirm Password do not match.'
      });
    }

    // Payload mapped to Domain Name API Subreseller schema
    const subresellerPayload = {
      ResellerName: resellerName,
      FirstName: firstName,
      LastName: lastName,
      Address: address,
      Company: companyName,
      City: city,
      State: state,
      Owner: owner,
      Country: country,
      ZipCode: zipCode,
      Phone: phone,
      Email: email,
      AlternativeEmail: alternativeEmail || '',
      WebSite: webLink || '',
      ResellerGroupId: resellerGroup,
      Username: username,
      Password: password
    };

    const result = await dnaClient.AddSubReseller(subresellerPayload);
    res.json({
      status: 'success',
      message: 'Subreseller created successfully on Domain API.',
      data: result
    });
  } catch (error) {
    handleApiError(res, error, 'Failed to create subreseller on Domain API.');
  }
});

// ==========================================
// 2. RESELLER PRICING & COST RETRIEVAL
// ==========================================

/**
 * Get Reseller Price List
 * Fetches the pricing tier set by the reseller directly on Domain Name API portal.
 */
app.get('/api/prices', async (req, res) => {
  try {
    const prices = await dnaClient.GetResellerPriceList();
    res.json({
      status: 'success',
      prices: prices
    });
  } catch (error) {
    handleApiError(res, error, 'Unable to retrieve price list from Domain API.');
  }
});

// ==========================================
// 3. DOMAIN OPERATIONS
// ==========================================

// Check Domain Availability
app.post('/api/check-domain', async (req, res) => {
  try {
    const { domainName, tld } = req.body;
    if (!domainName || !tld) {
      return res.status(400).json({
        status: 'error',
        message: 'Domain name and extension (TLD) are required.'
      });
    }
    const result = await dnaClient.CheckAvailability([domainName], [tld], 1);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Error checking domain availability.');
  }
});

// Register Domain
app.post('/api/register-domain', async (req, res) => {
  try {
    const result = await dnaClient.RegisterDomain(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Domain registration failed. Please verify contact details and balance.');
  }
});

// Transfer Domain
app.post('/api/transfer-domain', async (req, res) => {
  try {
    const result = await dnaClient.TransferDomain(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Domain transfer failed. Please check your EPP code.');
  }
});

// Renew Domain
app.post('/api/renew-domain', async (req, res) => {
  try {
    const result = await dnaClient.RenewDomain(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Domain renewal failed.');
  }
});

// Update Nameservers
app.post('/api/update-nameservers', async (req, res) => {
  try {
    const result = await dnaClient.SaveNameservers(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Failed to update nameservers.');
  }
});

// Manage DNS Records
app.post('/api/manage-dns', async (req, res) => {
  try {
    const result = await dnaClient.AddDnsRecord(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Failed to add DNS record.');
  }
});

// Child Nameservers (Glue Records)
app.post('/api/child-nameservers', async (req, res) => {
  try {
    const result = await dnaClient.AddChildNameServer(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Failed to register child nameserver.');
  }
});

// Update WHOIS Contacts
app.post('/api/update-contacts', async (req, res) => {
  try {
    const result = await dnaClient.SaveContactInformation(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Failed to update WHOIS contact details.');
  }
});

// Security: Toggle Transfer Lock
app.post('/api/toggle-lock', async (req, res) => {
  try {
    const result = await dnaClient.ModifyTransferLock(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Failed to update transfer lock status.');
  }
});

// Security: Retrieve EPP Auth Code
app.post('/api/get-epp', async (req, res) => {
  try {
    const result = await dnaClient.GetEppCode(req.body);
    res.json({ status: 'success', data: result });
  } catch (error) {
    handleApiError(res, error, 'Failed to retrieve EPP authorization code.');
  }
});

// Global Fallback Error Handler
app.use((err, req, res, next) => {
  res.status(500).json({
    status: 'error',
    message: err.message || 'An unexpected internal server error occurred.'
  });
});

// Start Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`L3 Markets Proxy Server running on port ${PORT}`);
});