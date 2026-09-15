require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const DomainNameApi = require('nodejs-dna');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Domain Name API Client for L3 Markets
const dnaClient = new DomainNameApi(
  process.env.RESELLER_ID,
  process.env.API_KEY
);

// 1. Endpoint: Check Domain Availability
app.post('/api/check-domain', async (req, res) => {
  const { domainName, tld } = req.body; // e.g., domainName: 'mybrand', tld: 'com'

  if (!domainName || !tld) {
    return res.status(400).json({ error: 'Domain name and TLD are required.' });
  }

  try {
    const results = await dnaClient.CheckAvailability([domainName], [tld], 1);
    
    // Response array handling
    if (Array.isArray(results) && results.length > 0) {
      const item = results[0];
      return res.json({
        domain: `${item.DomainName}.${item.TLD}`,
        status: item.Status, // 'available' or 'notavailable'
        price: item.Price,
        currency: item.Currency || 'USD'
      });
    }

    res.status(500).json({ error: 'Unexpected response from registrar.' });
  } catch (error) {
    console.error('L3 Markets API Error:', error);
    res.status(500).json({ error: 'Failed to check domain availability.' });
  }
});

// 2. Endpoint: Register Domain for User
app.post('/api/register-domain', async (req, res) => {
  const { domainName, period, contactInfo, nameservers } = req.body;

  if (!domainName || !contactInfo) {
    return res.status(400).json({ error: 'Missing registration parameters.' });
  }

  const registrationData = {
    DomainName: domainName,
    Period: period || 1,
    NameServers: nameservers || ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
    Contacts: {
      Registrant: {
        FirstName: contactInfo.firstName,
        LastName: contactInfo.lastName,
        EMail: contactInfo.email,
        Phone: contactInfo.phone,
        Address: contactInfo.address,
        City: contactInfo.city,
        State: contactInfo.state || 'N/A',
        ZipCode: contactInfo.zip,
        Country: contactInfo.countryCode || 'ZA', // Defaulting to South Africa ISO
        Company: 'L3 Markets Client'
      }
    }
  };

  try {
    const result = await dnaClient.RegisterDomain(registrationData);
    if (result && result.result === 'OK') {
      return res.json({
        success: true,
        message: `Website domain ${domainName} successfully registered under L3 Markets!`,
        details: result.data
      });
    }

    res.status(400).json({ success: false, error: result.error || 'Registration failed.' });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).json({ error: 'Server error processing registration.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`L3 Markets Hosting Platform running at http://localhost:${PORT}`);
});