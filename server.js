const express = require('express');
const cors = require('cors');
const soap = require('soap');

const app = express();

// ==========================================
// 1. CORS & SECURITY MIDDLEWARE CONFIGURATION
// ==========================================

/**
 * Configure Cross-Origin Resource Sharing (CORS)
 * Allows requests from any origin or specified client domains to prevent CORS policy blocks.
 */
const corsOptions = {
  origin: '*', // Allows all origins. Replace with specific domain in production (e.g., 'https://yourdomain.com')
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-KEY'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Enable preflight options for all endpoints

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global Request Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ==========================================
// 2. CONFIGURATION & STATE MANAGEMENT
// ==========================================

const PORT = process.env.PORT || 10000;
const DNA_WSDL_URL = process.env.DNA_WSDL_URL || 'https://api.domainnameapi.com/soap/v1/automation.asmx?wsdl';
const API_SECRET_TOKEN = process.env.API_SECRET_TOKEN || null;

let dnaClient = null;
let isInitializing = false;

// Optional Bearer / API Key Auth Guard
const authenticateRequest = (req, res, next) => {
  if (!API_SECRET_TOKEN) return next();
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  if (!authHeader || authHeader !== API_SECRET_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Key or Token' });
  }
  next();
};

// ==========================================
// 3. SOAP METHOD WRAPPER & DISCOVERY HELPER
// ==========================================

/**
 * Robust reflection helper to safely invoke DNA SOAP API methods regardless of 
 * naming variations (e.g., camelCase vs PascalCase or Promises vs Callbacks).
 */
async function callDnaMethod(methodName, params = {}) {
  if (!dnaClient) {
    throw new Error('DNA SOAP client is not ready. Server is still initializing connection.');
  }

  const asyncMethodName = `${methodName}Async`;

  // 1. Exact match for node-soap's promisified method
  if (typeof dnaClient[asyncMethodName] === 'function') {
    const [result] = await dnaClient[asyncMethodName](params);
    return result;
  }

  // 2. Exact match for callback method signature
  if (typeof dnaClient[methodName] === 'function') {
    return new Promise((resolve, reject) => {
      dnaClient[methodName](params, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // 3. Dynamic Case-Insensitive Search for method name variations
  const availableMethods = Object.keys(dnaClient).filter(
    (key) => typeof dnaClient[key] === 'function'
  );

  const matchedKey = availableMethods.find(
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
    `Method "${methodName}" not found on DNA Client. Available SOAP Methods: [${availableMethods.join(', ')}]`
  );
}

// ==========================================
// 4. SYSTEM & HEALTH ROUTES
// ==========================================

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    timestamp: new Date().toISOString(),
    soapConnected: !!dnaClient,
    corsEnabled: true
  });
});

app.get('/api/methods', authenticateRequest, (req, res) => {
  if (!dnaClient) {
    return res.status(503).json({ success: false, error: 'SOAP Client not initialized' });
  }
  const methods = Object.keys(dnaClient).filter(key => typeof dnaClient[key] === 'function');
  res.json({ success: true, count: methods.length, methods });
});

// ==========================================
// 5. RESELLER & ACCOUNT ROUTES
// ==========================================

// Fixed: GetResellerPriceList
app.get('/api/price-list', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetResellerPriceList', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reseller/balance', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetResellerBalance', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reseller/details', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetResellerDetails', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 6. DOMAIN SEARCH & AVAILABILITY ROUTES
// ==========================================

app.post('/api/domain/check-availability', authenticateRequest, async (req, res, next) => {
  try {
    const { DomainName } = req.body;
    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName parameter is required' });
    }
    const result = await callDnaMethod('CheckAvailability', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/check-availability-bulk', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('CheckAvailabilityBulk', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 7. DOMAIN LIFECYCLE MANAGEMENT ROUTES
// ==========================================

// Fixed: RegisterDomain
app.post('/api/register-domain', authenticateRequest, async (req, res, next) => {
  try {
    const { DomainName, Period } = req.body;
    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName is required for registration' });
    }
    const result = await callDnaMethod('RegisterDomain', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/renew', authenticateRequest, async (req, res, next) => {
  try {
    const { DomainName, Period } = req.body;
    if (!DomainName) {
      return res.status(400).json({ success: false, error: 'DomainName is required' });
    }
    const result = await callDnaMethod('RenewDomain', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/transfer', authenticateRequest, async (req, res, next) => {
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

app.get('/api/domain/info', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetDomainInfo', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/domain/list', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetDomainList', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/auth-code', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetAuthCode', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 8. NAMESERVER & DNS ROUTES
// ==========================================

app.post('/api/domain/nameservers/update', authenticateRequest, async (req, res, next) => {
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

app.get('/api/domain/nameservers', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetNameServers', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/child-nameserver/create', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('AddChildNameServer', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/child-nameserver/delete', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('DeleteChildNameServer', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 9. CONTACT & LOCK MANAGEMENT ROUTES
// ==========================================

app.post('/api/domain/contacts/update', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('UpdateContactInfo', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/domain/contacts', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('GetContactInfo', req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/lock/enable', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('EnableTransferLock', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/domain/lock/disable', authenticateRequest, async (req, res, next) => {
  try {
    const result = await callDnaMethod('DisableTransferLock', req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// 10. ERROR & FALLBACK MIDDLEWARE
// ==========================================

// Handle 404 Routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    requestedUrl: req.originalUrl
  });
});

// Global Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.toString(),
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ==========================================
// 11. INITIALIZATION & SERVER BOOTSTRAP
// ==========================================

async function initSoapClient(retryCount = 0) {
  isInitializing = true;
  try {
    console.log(`[SOAP INIT] Connecting to DNA WSDL (${DNA_WSDL_URL})...`);
    dnaClient = await soap.createClientAsync(DNA_WSDL_URL, {
      disableCache: true,
      endpoint: DNA_WSDL_URL.replace(/\?wsdl$/i, '')
    });
    console.log('[SOAP INIT] DNA SOAP Client initialized successfully.');
    isInitializing = false;
  } catch (error) {
    console.error(`[SOAP ERROR] Failed to load WSDL (Attempt ${retryCount + 1}):`, error.message);
    if (retryCount < 5) {
      console.log('[SOAP INIT] Retrying WSDL connection in 5 seconds...');
      setTimeout(() => initSoapClient(retryCount + 1), 5000);
    } else {
      console.error('[SOAP FATAL] Maximum retries reached. Server running without initialized SOAP client.');
      isInitializing = false;
    }
  }
}

async function startServer() {
  await initSoapClient();
  app.listen(PORT, () => {
    console.log(`================================================`);
    console.log(` Server running on port ${PORT}`);
    console.log(` CORS Policy: Unrestricted origins allowed (*)`);
    console.log(` Health Check: http://localhost:${PORT}/health`);
    console.log(`================================================`);
  });
}

startServer();