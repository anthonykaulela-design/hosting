const express = require('express');
const cors = require('cors');
const soap = require('soap');
const crypto = require('crypto');

const app = express();

// ============================================================================
// 1. SECURITY, CORS, AND BODY PARSER MIDDLEWARE
// ============================================================================

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-API-KEY',
    'X-SubReseller-ID',
    'X-SubReseller-Secret'
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  next();
});

// ============================================================================
// 2. CONFIGURATION & STATE MANAGEMENT
// ============================================================================

const PORT = process.env.PORT || 10000;
const DNA_WSDL_URL = process.env.DNA_WSDL_URL || 'https://api.domainnameapi.com/soap/v1/automation.asmx?wsdl';
const PARENT_API_KEY = process.env.PARENT_API_KEY || 'default_admin_secret_key';

let dnaClient = null;

// In-Memory Database for Sub-Resellers and Ledger (Replace with MySQL/MongoDB in production)
const db = {
  subResellers: new Map(),
  transactions: [],
  logs: []
};

// Default Admin Sub-Reseller Seed
db.subResellers.set('SUB-1001', {
  id: 'SUB-1001',
  name: 'Default SubReseller Ltd',
  email: 'sub@reseller.com',
  apiKey: 'sub_key_1001',
  secret: 'sub_secret_1001',
  balance: 500.00,
  currency: 'USD',
  marginPercentage: 10, // 10% markup on wholesale price
  status: 'ACTIVE',
  createdAt: new Date().toISOString()
});

// ============================================================================
// 3. SOAP METHOD WRAPPER & REFLECTION ENGINE
// ============================================================================

/**
 * Dynamically resolves and invokes DNA SOAP API methods regardless of whether 
 * node-soap exports callback methods, promisified (*Async) variants, or case shifts.
 */
async function callDnaMethod(methodName, params = {}) {
  if (!dnaClient) {
    throw new Error('DNA SOAP client is not connected to remote server yet. Try again in a few seconds.');
  }

  const asyncMethodName = `${methodName}Async`;

  // 1. Direct match for node-soap Async promise method
  if (typeof dnaClient[asyncMethodName] === 'function') {
    const [result] = await dnaClient[asyncMethodName](params);
    return result;
  }

  // 2. Direct match for standard callback method signature
  if (typeof dnaClient[methodName] === 'function') {
    return new Promise((resolve, reject) => {
      dnaClient[methodName](params, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // 3. Case-Insensitive method discovery fallback
  const clientKeys = Object.keys(dnaClient).filter(
    (key) => typeof dnaClient[key] === 'function'
  );

  const matchedKey = clientKeys.find(
    (key) => key.toLowerCase() === methodName.toLowerCase() || 
             key.toLowerCase() === asyncMethodName.toLowerCase()
  );

  if (matchedKey) {
    if (matchedKey.endsWith('Async')) {
      const [result] = await dnaClient[matchedKey](params);
      return result;
    }
    return new Promise((resolve, reject) => {
      dnaClient[matchedKey](params, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  throw new TypeError(
    `Method "${methodName}" not found on DNA SOAP client. Available methods: [${clientKeys.join(', ')}]`
  );
}

// ============================================================================
// 4. AUTHENTICATION & SUB-RESELLER MIDDLEWARE
// ============================================================================

/**
 * Authentication middleware that identifies whether a request comes from 
 * the Master Reseller or a Sub-Reseller via headers.
 */
const authenticateRole = (req, res, next) => {
  const masterKey = req.headers['x-api-key'] || req.headers['authorization'];
  const subResellerId = req.headers['x-subreseller-id'];
  const subResellerSecret = req.headers['x-subreseller-secret'];

  // Master Admin Auth
  if (masterKey === PARENT_API_KEY || !process.env.PARENT_API_KEY) {
    req.userRole = 'MASTER';
    return next();
  }

  // Sub-Reseller Auth
  if (subResellerId && subResellerSecret) {
    const sub = db.subResellers.get(subResellerId);
    if (sub && sub.secret === subResellerSecret && sub.status === 'ACTIVE') {
      req.userRole = 'SUB_RESELLER';
      req.subReseller = sub;
      return next();
    }
    return res.status(401).json({ success: false, error: 'Invalid or suspended Sub-Reseller credentials.' });
  }

  // If no auth headers provided, check if anonymous mode is allowed or reject
  req.userRole = 'ANONYMOUS';
  next();
};

/**
 * Ensures Sub-Reseller has sufficient balance before initiating financial operations.
 */
const verifySubResellerBalance = (estimatedCost) => {
  return (req, res, next) => {
    if (req.userRole === 'SUB_RESELLER') {
      const sub = req.subReseller;
      if (sub.balance < estimatedCost) {
        return res.status(402).json({
          success: false,
          error: 'Payment Required: Insufficient Sub-Reseller balance.',
          currentBalance: sub.balance,
          required: estimatedCost
        });
      }
    }
    next();
  };
};

// Helper to log transaction ledger entry
function recordTransaction(subId, type, amount, domainName, status) {
  const entry = {
    id: `TX-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    subResellerId: subId,
    type,
    amount,
    domainName,
    status,
    timestamp: new Date().toISOString()
  };
  db.transactions.push(entry);
  return entry;
}

// ============================================================================
// 5. SYSTEM & MONITORING ROUTES
// ============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    timestamp: new Date().toISOString(),
    soapConnected: !!dnaClient,
    corsPolicy: 'Unrestricted (*)',
    subResellersCount: db.subResellers.size
  });
});

app.get('/api/soap/methods', authenticateRole, (req, res) => {
  if (!dnaClient) {
    return res.status(503).json({ success: false, error: 'SOAP Client non-responsive' });
  }
  const methods = Object.keys(dnaClient).filter(k => typeof dnaClient[k] === 'function');
  res.json({ success: true, count: methods.length, methods });
});

// ============================================================================
// 6. SUB-RESELLER MANAGEMENT ROUTES (ADMIN ONLY)
// ============================================================================

// Create a new Sub-Reseller
app.post('/api/admin/subresellers', authenticateRole, (req, res) => {
  if (req.userRole !== 'MASTER') {
    return res.status(403).json({ success: false, error: 'Access denied: Master Admin permissions required.' });
  }

  const { name, email, initialDeposit = 0, marginPercentage = 10 } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'Missing required parameters: name, email' });
  }

  const id = `SUB-${Math.floor(1000 + Math.random() * 9000)}`;
  const apiKey = `key_${crypto.randomBytes(8).toString('hex')}`;
  const secret = `sec_${crypto.randomBytes(16).toString('hex')}`;

  const newSub = {
    id,
    name,
    email,
    apiKey,
    secret,
    balance: parseFloat(initialDeposit),
    currency: 'USD',
    marginPercentage: parseFloat(marginPercentage),
    status: 'ACTIVE',
    createdAt: new Date().toISOString()
  };

  db.subResellers.set(id, newSub);

  res.status(201).json({
    success: true,
    message: 'Sub-Reseller account created successfully',
    data: newSub
  });
});

// Get all Sub-Resellers
app.get('/api/admin/subresellers', authenticateRole, (req, res) => {
  if (req.userRole !== 'MASTER') {
    return res.status(403).json({ success: false, error: 'Master Admin required' });
  }
  const list = Array.from(db.subResellers.values());
  res.json({ success: true, count: list.length, data: list });
});

// Top-up Sub-Reseller balance
app.post('/api/admin/subresellers/topup', authenticateRole, (req, res) => {
  if (req.userRole !== 'MASTER') {
    return res.status(403).json({ success: false, error: 'Master Admin required' });
  }

  const { subResellerId, amount } = req.body;
  const sub = db.subResellers.get(subResellerId);

  if (!sub) {
    return res.status(404).json({ success: false, error: 'Sub-Reseller not found' });
  }

  const topupAmount = parseFloat(amount);
  if (isNaN(topupAmount) || topupAmount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid topup amount' });
  }

  sub.balance += topupAmount;
  recordTransaction(subResellerId, 'TOPUP', topupAmount, 'N/A', 'SUCCESS');

  res.json({
    success: true,
    message: `Added $${topupAmount} to ${sub.name}`,
    newBalance: sub.balance
  });
});

// ============================================================================
// 7. PRICING & BALANCES (RESELLER & SUB-RESELLER)
// ============================================================================

// Wholesale vs Sub-reseller Price List Endpoint
app.get('/api/price-list', authenticateRole, async (req, res, next) => {
  try {
    const rawPrices = await callDnaMethod('GetResellerPriceList', req.query);

    // Apply Margin if requested by a Sub-Reseller
    if (req.userRole === 'SUB_RESELLER') {
      const margin = (100 + req.subReseller.marginPercentage) / 100;
      
      // Transform price lists dynamically with margin added
      const adjustedPrices = JSON.parse(JSON.stringify(rawPrices), (key, value) => {
        if (typeof value === 'number' && key.toLowerCase().includes('price')) {
          return Number((value * margin).toFixed(2));
        }
        return value;
      });

      return res.json({
        success: true,
        userRole: 'SUB_RESELLER',
        marginApplied: `${req.subReseller.marginPercentage}%`,
        data: adjustedPrices
      });
    }

    res.json({ success: true, userRole: req.userRole, data: rawPrices });
  } catch (error) {
    next(error);
  }
});

// Reseller Balance Check
app.get('/api/balance', authenticateRole, async (req, res, next) => {
  try {
    if (req.userRole === 'SUB_RESELLER') {
      return res.json({
        success: true,
        accountType: 'SUB_RESELLER',
        balance: req.subReseller.balance,
        currency: req.subReseller.currency
      });
    }

    const wholesaleBalance = await callDnaMethod('GetResellerBalance', req.query);
    res.json({ success: true, accountType: 'MASTER', data: wholesaleBalance });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// 8. DOMAIN SEARCH & AVAILABILITY ROUTES
// ============================================================================

app.post('/api/domain/check-availability', authenticateRole, async (req, res, next) => {
  try {
    const { DomainName } = req.body;
    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName is required' });
    }

    const result = await callDnaMethod('CheckAvailability', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/check-bulk', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('CheckAvailabilityBulk', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// 9. DOMAIN REGISTRATION & LIFECYCLE (WITH SUB-RESELLER SUPPORT)
// ============================================================================

// Domain Registration Route (Fixed Line 180 issue)
app.post('/api/register-domain', authenticateRole, async (req, res, next) => {
  try {
    const { DomainName, Period = 1, RegistrantContact, AdministrativeContact } = req.body;

    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName parameter is required' });
    }

    // Cost verification logic for Sub-Resellers
    const baseEstimatedCost = 10.00 * Period; // Example baseline cost estimate
    let finalCost = baseEstimatedCost;

    if (req.userRole === 'SUB_RESELLER') {
      const sub = req.subReseller;
      finalCost = baseEstimatedCost * ((100 + sub.marginPercentage) / 100);

      if (sub.balance < finalCost) {
        return res.status(402).json({
          success: false,
          error: 'Insufficient Sub-Reseller balance for registration.',
          requiredBalance: finalCost,
          currentBalance: sub.balance
        });
      }
    }

    // Execute SOAP call to Parent Registry API
    const soapResult = await callDnaMethod('RegisterDomain', req.body);

    // Deduct balance and record transaction if Sub-Reseller
    if (req.userRole === 'SUB_RESELLER') {
      req.subReseller.balance -= finalCost;
      recordTransaction(req.subReseller.id, 'DOMAIN_REGISTER', finalCost, DomainName, 'SUCCESS');
    }

    res.json({
      success: true,
      registeredBy: req.userRole,
      chargedAmount: req.userRole === 'SUB_RESELLER' ? finalCost : 'WHOLESALE',
      data: soapResult
    });
  } catch (error) {
    if (req.userRole === 'SUB_RESELLER' && req.body.DomainName) {
      recordTransaction(req.subReseller.id, 'DOMAIN_REGISTER_FAILED', 0, req.body.DomainName, 'FAILED');
    }
    next(error);
  }
});

// Renew Domain Route
app.post('/api/domain/renew', authenticateRole, async (req, res, next) => {
  try {
    const { DomainName, Period = 1 } = req.body;
    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName is required' });
    }

    const result = await callDnaMethod('RenewDomain', req.body);

    if (req.userRole === 'SUB_RESELLER') {
      const renewalCost = 10.00 * Period * ((100 + req.subReseller.marginPercentage) / 100);
      req.subReseller.balance -= renewalCost;
      recordTransaction(req.subReseller.id, 'DOMAIN_RENEW', renewalCost, DomainName, 'SUCCESS');
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Transfer Domain Route
app.post('/api/domain/transfer', authenticateRole, async (req, res, next) => {
  try {
    const { DomainName, AuthCode } = req.body;
    if (!DomainName || !AuthCode) {
      return res.status(400).json({ success: false, error: 'DomainName and AuthCode are required' });
    }

    const result = await callDnaMethod('TransferDomain', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Get Domain Information
app.get('/api/domain/info', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetDomainInfo', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Get EPP Transfer Code
app.post('/api/domain/authcode', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetAuthCode', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// 10. NAMESERVERS & DNS MANAGEMENT ROUTES
// ============================================================================

app.post('/api/domain/nameservers/update', authenticateRole, async (req, res, next) => {
  try {
    const { DomainName, NameServers } = req.body;
    if (!DomainName || !NameServers) {
      return res.status(400).json({ success: false, error: 'DomainName and NameServers are required' });
    }
    const result = await callDnaMethod('UpdateNameServers', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/domain/nameservers', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetNameServers', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/child-nameserver/add', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('AddChildNameServer', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/child-nameserver/delete', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('DeleteChildNameServer', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// 11. CONTACTS & PRIVACY / LOCK MANAGEMENT ROUTES
// ============================================================================

app.post('/api/domain/contacts/update', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('UpdateContactInfo', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/lock/enable', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('EnableTransferLock', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/lock/disable', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('DisableTransferLock', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// 12. LEDGER & AUDIT TRAIL ROUTES
// ============================================================================

app.get('/api/transactions', authenticateRole, (req, res) => {
  if (req.userRole === 'SUB_RESELLER') {
    const subTxs = db.transactions.filter(t => t.subResellerId === req.subReseller.id);
    return res.json({ success: true, count: subTxs.length, data: subTxs });
  }
  
  if (req.userRole === 'MASTER') {
    return res.json({ success: true, count: db.transactions.length, data: db.transactions });
  }

  res.status(403).json({ success: false, error: 'Unauthorized to view financial audit log.' });
});

// ============================================================================
// 13. ERROR HANDLING & FALLBACK MIDDLEWARE
// ============================================================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    requestedEndpoint: req.originalUrl
  });
});

// Global Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected server error occurred.',
    path: req.originalUrl
  });
});

// ============================================================================
// 14. SERVER BOOTSTRAP & INITIALIZATION
// ============================================================================

async function startServer() {
  try {
    console.log(`[BOOT] Initializing DNA SOAP Client connection to ${DNA_WSDL_URL}...`);
    
    // Connect to SOAP API service before binding Express to port
    dnaClient = await soap.createClientAsync(DNA_WSDL_URL, {
      disableCache: true,
      endpoint: DNA_WSDL_URL.replace(/\?wsdl$/i, '')
    });
    
    console.log('[BOOT] DNA SOAP Client successfully initialized and bound.');

    app.listen(PORT, () => {
      console.log('====================================================');
      console.log(` SERVER RUNNING ON PORT : ${PORT}`);
      console.log(` CORS SETTING            : Allowed (*)` );
      console.log(` SUB-RESELLER SYSTEM     : Enabled`);
      console.log(` HEALTH CHECK            : http://localhost:${PORT}/health`);
      console.log('====================================================');
    });
  } catch (error) {
    console.error('[BOOT ERROR] Critical failure during server startup:', error.message);
    // Retry connection after 5 seconds instead of crashing process immediately
    setTimeout(startServer, 5000);
  }
}

startServer();