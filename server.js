/**
 * Embassy Entry Queue System - Standalone Server
 * Zero dependencies - just run: node server.js
 * Serves frontend + API on port 3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const CALLBACK_HOST = process.env.CALLBACK_HOST || 'https://embassy.kobeapptz.com';
const PP_KEY = '0HNndAwG6NIXcksD1kRxHVHMgUtDi8GqgMfMQrymleH8HluAdA1ZRAl2jG3B';
const PP_VENDOR = '531'; // PalmPesa Vendor ID
const PP_BASE = 'https://palmpesa.drmlelwa.co.tz/api';

// ===== IN-MEMORY DATABASE =====
const DB = {
  tickets: [],
  scans: [],
  counter: 0
};

function pad(n) { return String(n).padStart(3, '0'); }

function loadDB() {
  try {
    const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
    DB.tickets = data.tickets || [];
    DB.scans = data.scans || [];
    DB.counter = data.counter || 0;
  } catch(e) {}
}

function saveDB() {
  fs.writeFileSync('./data.json', JSON.stringify(DB, null, 2));
}

loadDB();

// ===== PALMPESA API =====
async function ppInitiate(data) {
  const res = await fetch(PP_BASE + '/palmpesa/initiate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PP_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: data.name,
      email: data.email || 'noemail@example.com',
      phone: data.phone,
      amount: data.amount,
      transaction_id: data.transaction_id,
      address: 'Dar es Salaam',
      postcode: '11111',
      callback_url: data.callback_url,
    }),
  });
  return res.json();
}

// ===== ROUTES =====
const routes = {
  'GET /api/health': () => ({ status: 'ok', palmPesa: true, vendor: PP_VENDOR }),

  'GET /api/queue': () => {
    const active = DB.tickets.filter(t => t.status === 'active');
    const used = DB.tickets.filter(t => t.status === 'used');
    return {
      total: DB.tickets.length,
      active: active.length,
      used: used.length,
      waiting: active.length,
      last_number: DB.counter,
      currently_serving: used.length,
    };
  },

  'POST /api/ticket': (body) => {
    const { name, phone, email } = body;
    if (!name || !phone) return { error: 'Name and phone required', status: 400 };
    DB.counter++;
    const number = 'E-' + pad(DB.counter);
    DB.tickets.push({
      id: DB.counter, number, name,
      phone: phone.replace(/^\+/, ''),
      email: email || null,
      status: 'pending',
      queue_position: DB.counter,
      order_id: null, tx_id: null,
      channel: null, amount: 100,
      created_at: new Date().toISOString(),
      paid_at: null, used_at: null,
    });
    saveDB();
    return { success: true, ticket: { number, name, phone, position: DB.counter, status: 'pending' } };
  },

  'GET /api/ticket/:number': (_, params) => {
    const ticket = DB.tickets.find(t => t.number === params.number);
    if (!ticket) return { error: 'Ticket not found', status: 404 };
    const ahead = DB.tickets.filter(t => t.status === 'active' && t.queue_position < ticket.queue_position).length;
    return { ticket: { ...ticket, ahead_in_queue: ahead } };
  },

  'POST /api/pay/:number': async (body, params) => {
    const ticket = DB.tickets.find(t => t.number === params.number);
    if (!ticket) return { error: 'Ticket not found', status: 404 };
    if (ticket.status === 'active') return { error: 'Already paid', status: 400 };
    if (ticket.status === 'used') return { error: 'Already used', status: 400 };

    const txId = 'EMB_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    ticket.tx_id = txId;
    saveDB();

    try {
      const result = await ppInitiate({
        name: ticket.name, email: ticket.email,
        phone: ticket.phone, amount: ticket.amount,
        transaction_id: txId,
        callback_url: `${CALLBACK_HOST}/api/webhook/palmpesa`,
      });
      if (result.order_id) {
        ticket.order_id = result.order_id;
        saveDB();
        return { success: true, message: 'Payment request sent', order_id: result.order_id };
      }
      return { error: 'Failed to initiate', details: result, status: 500 };
    } catch (err) {
      return { error: 'Payment failed: ' + err.message, status: 500 };
    }
  },

  'POST /api/webhook/palmpesa': async (body) => {
    console.log('[Webhook]', JSON.stringify(body));
    const orderId = body.order_id || (body.data && body.data[0] && body.data[0].order_id);
    const status = body.payment_status || (body.data && body.data[0] && body.data[0].payment_status);
    if (!orderId) return { error: 'No order_id', status: 400 };
    if (status === 'COMPLETED') {
      const ticket = DB.tickets.find(t => t.order_id === orderId || t.tx_id === orderId);
      if (ticket && ticket.status === 'pending') {
        ticket.status = 'active';
        ticket.paid_at = new Date().toISOString();
        ticket.channel = body.channel || (body.data && body.data[0] && body.data[0].channel);
        saveDB();
        return { success: true, message: 'Ticket activated', number: ticket.number };
      }
    }
    return { success: true, message: `Status: ${status}` };
  },

  'POST /api/check-payment/:number': async (body, params) => {
    const ticket = DB.tickets.find(t => t.number === params.number);
    if (!ticket) return { error: 'Not found', status: 404 };
    if (ticket.status === 'active') {
      const ahead = DB.tickets.filter(t => t.status === 'active' && t.queue_position < ticket.queue_position).length;
      return { status: 'active', ticket: { ...ticket, ahead_in_queue: ahead } };
    }
    if (ticket.status === 'used') return { status: 'used', ticket };
    if (ticket.order_id) {
      try {
        const res = await fetch(PP_BASE + '/order-status', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${PP_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: ticket.order_id }),
        });
        const data = await res.json();
        const pd = data.data && data.data[0] ? data.data[0] : null;
        if (pd && pd.payment_status === 'COMPLETED') {
          ticket.status = 'active'; ticket.paid_at = new Date().toISOString();
          ticket.channel = pd.channel; saveDB();
          const ahead = DB.tickets.filter(t => t.status === 'active' && t.queue_position < ticket.queue_position).length;
          return { status: 'active', ticket: { ...ticket, ahead_in_queue: ahead } };
        }
      } catch(e) {}
    }
    return { status: 'pending', ticket };
  },

  'POST /api/scan/:number': (body, params) => {
    const ticket = DB.tickets.find(t => t.number === params.number);
    if (!ticket) return { error: 'Ticket not found', granted: false, status: 404 };
    if (ticket.status === 'used') return { granted: false, error: `Already used at ${ticket.used_at}`, ticket: { number: ticket.number, name: ticket.name, used_at: ticket.used_at }, status: 403 };
    if (ticket.status !== 'active') return { granted: false, error: 'Payment not completed - ticket is RED', ticket: { number: ticket.number, name: ticket.name, status: ticket.status }, status: 403 };
    ticket.status = 'used'; ticket.used_at = new Date().toISOString();
    DB.scans.push({ ticket_id: ticket.id, scanned_at: new Date().toISOString() });
    saveDB();
    return { granted: true, message: 'ENTRY GRANTED', ticket: { number: ticket.number, name: ticket.name, used_at: ticket.used_at } };
  },
};

// ===== SERVE FRONTEND =====
function getFrontendHTML() {
  try { return fs.readFileSync('./index.html', 'utf8'); }
  catch { return '<h1>Frontend not found. Place index.html in the same folder.</h1>'; }
}

const FRONTEND_HTML = getFrontendHTML();

// ===== HTTP SERVER =====
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Serve frontend HTML for root and non-API paths
  if (pathname === '/' || pathname === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(FRONTEND_HTML);
    return;
  }

  // Parse body for POST requests
  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    try { body = JSON.parse(raw); } catch { body = {}; }
  }

  // Route matching
  const pathParts = pathname.replace(/^\/api\//, '').split('/');
  const basePath = pathParts[0];
  const param = pathParts[1];

  const routeKey = `${req.method} ${pathname}`;
  const baseRouteKey = param ? `${req.method} /api/${basePath}/:number` : routeKey;

  const handler = routes[routeKey] || routes[baseRouteKey];

  if (!handler) {
    // Serve frontend HTML for SPA routing (shared ticket links, etc.)
    if (!pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(FRONTEND_HTML);
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found', path: pathname }));
    return;
  }

  try {
    const params = param ? { number: param.toUpperCase() } : {};
    const result = await handler(body, params);
    const statusCode = typeof result.status === 'number' ? result.status : 200;
    delete result.status;
    res.writeHead(statusCode);
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[Error]', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`
==========================================
  Embassy Entry System - RUNNING
==========================================
  URL: http://localhost:${PORT}
  Guard PIN: 1234
  PalmPesa: Connected (Vendor: ${PP_VENDOR})
==========================================
`);
});
