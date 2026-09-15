const express = require('express');
const cors = require('cors');
const soap = require('soap');
const crypto = require('crypto');

const app = express();

// ============================================================================
// 1. CORS & SECURITY MIDDLEWARE CONFIGURATION
// ============================================================================

// Enable CORS for all origins and headers
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

// app.use(cors(...)) handles both regular and OPTIONS preflight requests automatically
app.use(cors(corsOptions));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Global Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ============================================================================
// 2. CONFIGURATION & LOCAL IN-MEMORY DATABASE
// ============================================================================

const PORT = process.env.PORT || 10000;
const DNA_WSDL_URL = process.env.DNA_WSDL_URL || 'https://api.domainnameapi.com/soap/v1/automation.asmx?wsdl';
const MASTER_API_KEY = process.env.MASTER_API_KEY || 'master_secret_key';

let dnaClient = null;

// Local store for Sub-Resellers and Transactions
const db = {
  subResellers: new Map(),
  transactions: []
};

// Seed default Sub-Reseller account for testing
db.subResellers.set('SUB-1001', {
  id: 'SUB-1001',
  name: 'Default SubReseller',
  email: 'sub@reseller.com',
  apiKey: 'sub_key_1001',
  secret: 'sub_secret_1001',
  balance: 500.00,
  currency: 'USD',
  marginPercentage: 10, // 10% markup over wholesale price
  status: 'ACTIVE',
  createdAt: new Date().toISOString()
});

// ============================================================================
// 3. SAFE SOAP METHOD WRAPPER
// ============================================================================

/**
 * Safely invokes SOAP methods on the DNA client regardless of method casing
 * or whether the method uses callbacks or Async promises (*Async).
 */
async function callDnaMethod(methodName, params = {}) {
  if (!dnaClient) {
    throw new Error('DNA SOAP client is not initialized yet. Please try again shortly.');
  }

  const asyncMethod = `${methodName}Async`;

  // 1. Check for node-soap's generated Async promise method
  if (typeof dnaClient[asyncMethod] === 'function') {
    const [result] = await dnaClient[asyncMethod](params);
    return result;
  }

  // 2. Check for callback-based method signature
  if (typeof dnaClient[methodName] === 'function') {
    return new Promise((resolve, reject) => {
      dnaClient[methodName](params, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // 3. Case-insensitive lookup fallback
  const clientMethods = Object.keys(dnaClient).filter(
    (key) => typeof dnaClient[key] === 'function'
  );

  const matchedKey = clientMethods.find(
    (key) => key.toLowerCase() === methodName.toLowerCase() || 
             key.toLowerCase() === asyncMethod.toLowerCase()
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
    `Method "${methodName}" is not available on DomainNameAPI SOAP Client. Available methods: [${clientMethods.join(', ')}]`
  );
}

// ============================================================================
// 4. AUTHENTICATION MIDDLEWARE
// ============================================================================

const authenticateRole = (req, res, next) => {
  const masterKey = req.headers['x-api-key'] || req.headers['authorization'];
  const subId = req.headers['x-subreseller-id'];
  const subSecret = req.headers['x-subreseller-secret'];

  // Master Admin Authentication
  if (masterKey === MASTER_API_KEY || !process.env.MASTER_API_KEY) {
    req.userRole = 'MASTER';
    return next();
  }

  // Sub-Reseller Authentication
  if (subId && subSecret) {
    const sub = db.subResellers.get(subId);
    if (sub && sub.secret === subSecret && sub.status === 'ACTIVE') {
      req.userRole = 'SUB_RESELLER';
      req.subReseller = sub;
      return next();
    }
    return res.status(401).json({ success: false, error: 'Invalid or inactive Sub-Reseller credentials.' });
  }

  req.userRole = 'ANONYMOUS';
  next();
};

function recordTransaction(subId, type, amount, domainName, status) {
  const tx = {
    id: `TX-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    subResellerId: subId,
    type,
    amount,
    domainName,
    status,
    timestamp: new Date().toISOString()
  };
  db.transactions.push(tx);
  return tx;
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
    registeredSubResellers: db.subResellers.size
  });
});

app.get('/api/soap/methods', authenticateRole, (req, res) => {
  if (!dnaClient) {
    return res.status(503).json({ success: false, error: 'SOAP Client not initialized' });
  }
  const methods = Object.keys(dnaClient).filter(k => typeof dnaClient[k] === 'function');
  res.json({ success: true, count: methods.length, methods });
});

// ============================================================================
// 6. LOCAL SUB-RESELLER MANAGEMENT
// ============================================================================

const handleAddSubReseller = (req, res) => {
  const { name, email, initialDeposit = 0, marginPercentage = 10 } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'Name and email are required parameters.' });
  }

  const id = `SUB-${Math.floor(1000 + Math.random() * 9000)}`;
  const apiKey = `key_${crypto.randomBytes(8).toString('hex')}`;
  const secret = `sec_${crypto.randomBytes(16).toString('hex')}`;

  const newSubReseller = {
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

  db.subResellers.set(id, newSubReseller);

  res.status(201).json({
    success: true,
    message: 'Sub-Reseller registered successfully.',
    data: newSubReseller
  });
};

app.post('/api/admin/subresellers', authenticateRole, handleAddSubReseller);
app.post('/api/subreseller/register', authenticateRole, handleAddSubReseller);
app.post('/api/add-subreseller', authenticateRole, handleAddSubReseller);

app.get('/api/admin/subresellers', authenticateRole, (req, res) => {
  const list = Array.from(db.subResellers.values());
  res.json({ success: true, count: list.length, data: list });
});

app.post('/api/admin/subresellers/topup', authenticateRole, (req, res) => {
  const { subResellerId, amount } = req.body;
  const sub = db.subResellers.get(subResellerId);

  if (!sub) {
    return res.status(404).json({ success: false, error: 'Sub-Reseller account not found.' });
  }

  const topupAmount = parseFloat(amount);
  if (isNaN(topupAmount) || topupAmount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid top-up amount.' });
  }

  sub.balance += topupAmount;
  recordTransaction(subResellerId, 'TOPUP', topupAmount, 'N/A', 'SUCCESS');

  res.json({
    success: true,
    message: `Added $${topupAmount} to balance of ${sub.name}`,
    newBalance: sub.balance
  });
});

// ============================================================================
// 7. PRICING & BALANCE ENDPOINTS
// ============================================================================

app.get('/api/price-list', authenticateRole, async (req, res, next) => {
  try {
    const rawPrices = await callDnaMethod('GetResellerPriceList', req.query);

    if (req.userRole === 'SUB_RESELLER') {
      const margin = (100 + req.subReseller.marginPercentage) / 100;
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
// 8. DOMAIN SEARCH & REGISTRATION ROUTES
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

app.post('/api/register-domain', authenticateRole, async (req, res, next) => {
  try {
    const { DomainName, Period = 1 } = req.body;

    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName parameter is required' });
    }

    const baseEstimatedCost = 10.00 * Period;
    let finalCost = baseEstimatedCost;

    if (req.userRole === 'SUB_RESELLER') {
      const sub = req.subReseller;
      finalCost = baseEstimatedCost * ((100 + sub.marginPercentage) / 100);

      if (sub.balance < finalCost) {
        return res.status(402).json({
          success: false,
          error: 'Insufficient Sub-Reseller balance for domain registration.',
          requiredAmount: finalCost,
          currentBalance: sub.balance
        });
      }
    }

    const soapResult = await callDnaMethod('RegisterDomain', req.body);

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

app.get('/api/domain/info', authenticateRole, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetDomainInfo', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// 9. NAMESERVERS & CONTACT MANAGEMENT
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
// 10. ERROR & FALLBACK MIDDLEWARE
// ============================================================================

// 404 Route Not Found
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    requestedEndpoint: req.originalUrl
  });
});

// Global Centralized Error Handling
app.use((err, req, res, next) => {
  console.error('[API ERROR]', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    error: err.name || 'API_Error',
    message: err.message || 'An unexpected error occurred.'
  });
});

// ============================================================================
// 11. SERVER BOOTSTRAP
// ============================================================================

async function startServer() {
  try {
    console.log(`[BOOT] Connecting to DomainNameAPI WSDL at ${DNA_WSDL_URL}...`);

    dnaClient = await soap.createClientAsync(DNA_WSDL_URL, {
      disableCache: true,
      endpoint: DNA_WSDL_URL.replace(/\?wsdl$/i, '')
    });

    console.log('[BOOT] DNA SOAP Client initialized successfully.');

    app.listen(PORT, () => {
      console.log(`====================================================`);
      console.log(` SERVER RUNNING ON PORT : ${PORT}`);
      console.log(` CORS POLICY            : Allowed (*)` );
      console.log(` SUB-RESELLER ROUTE     : Enabled (/api/subreseller/register)`);
      console.log(` HEALTH CHECK           : http://localhost:${PORT}/health`);
      console.log(`====================================================`);
    });
  } catch (error) {
    console.error('[BOOT ERROR] Initial WSDL connection failed:', error.message);
    console.log('[BOOT] Retrying connection in 5 seconds...');
    setTimeout(startServer, 5000);
  }
}

startServer();