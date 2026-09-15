require('dotenv').config();
const express = require('express');
const cors = require('cors');
const DomainNameApi = require('nodejs-dna');

const app = express();

// 1. Configure Full Open CORS Policy (Fixes Browser Blocking)
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight options handler for all routes

// 2. Parse JSON Payload Data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Initialize Domain Name API Client for L3 Markets
const resellerId = process.env.RESELLER_ID || '63ee50a9-2031-181a-df7b-3a23b6486daf';
const apiKey = process.env.API_KEY || 'yat7dN3z6ZEGzsBhm792sqUl6SPpBmU6NFMI1fyk';

const dnaClient = new DomainNameApi(resellerId, apiKey);

// Health Check Endpoint (Loads when opening https://hosting-5572.onrender.com directly)
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'Active',
    company: 'L3 Markets Backend Server',
    message: 'Domain Name API integration service is running successfully.'
  });
});

// 1. Endpoint: Check Domain Availability
app.post('/api/check-domain', async (req, res) => {
  try {
    const { domainName, tld } = req.body;
    if (!domainName || !tld) {
      return res.status(400).json({ error: 'Both domainName and tld are required.' });
    }
    const result = await dnaClient.CheckAvailability([domainName], [tld], 1);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error checking domain availability.' });
  }
});

// 2. Endpoint: Register New Domain
app.post('/api/register-domain', async (req, res) => {
  try {
    const result = await dnaClient.RegisterDomain(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error registering domain.' });
  }
});

// 3. Endpoint: Domain Transfer
app.post('/api/transfer-domain', async (req, res) => {
  try {
    const result = await dnaClient.TransferDomain(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error executing domain transfer.' });
  }
});

// 4. Endpoint: Domain Renewal
app.post('/api/renew-domain', async (req, res) => {
  try {
    const result = await dnaClient.RenewDomain(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error renewing domain.' });
  }
});

// 5. Endpoint: Update Nameservers
app.post('/api/update-nameservers', async (req, res) => {
  try {
    const result = await dnaClient.SaveNameservers(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error updating nameservers.' });
  }
});

// 6. Endpoint: Manage DNS Records
app.post('/api/manage-dns', async (req, res) => {
  try {
    const result = await dnaClient.AddDnsRecord(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error adding DNS record.' });
  }
});

// 7. Endpoint: Child Nameservers (Glue Records)
app.post('/api/child-nameservers', async (req, res) => {
  try {
    const result = await dnaClient.AddChildNameServer(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error creating child nameserver.' });
  }
});

// 8. Endpoint: Update WHOIS Contacts
app.post('/api/update-contacts', async (req, res) => {
  try {
    const result = await dnaClient.SaveContactInformation(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error updating contact details.' });
  }
});

// 9. Endpoint: Toggle Transfer Lock Status
app.post('/api/toggle-lock', async (req, res) => {
  try {
    const result = await dnaClient.ModifyTransferLock(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error modifying transfer lock.' });
  }
});

// 10. Endpoint: Retrieve EPP / Auth Code
app.post('/api/get-epp', async (req, res) => {
  try {
    const result = await dnaClient.GetEppCode(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error retrieving EPP code.' });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`L3 Markets API Backend running on port ${PORT}`);
});