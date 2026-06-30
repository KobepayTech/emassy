# Embassy Entry Number System

Digital queue management system with PalmPesa payments for embassy entry.

## Features

- Get free entry numbers (E-001, E-002...)
- Pay 5,000 TZS via PalmPesa (M-Pesa, Airtel, Tigo, Halotel, TTCL)
- QR code verification for guards
- One-time scan tickets
- Live queue position tracking
- WhatsApp sharing
- Camera QR scanner for guards

## Quick Start

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/embassy-entry-system.git
cd embassy-entry-system

# 2. Run
node server.js

# 3. Open browser
# http://localhost:3000
```

## Deploy

### Render
1. Go to render.com
2. New Web Service
3. Connect this GitHub repo
4. Start Command: `node server.js`
5. Add env vars: PALMPESA_API_KEY, PALMPESA_VENDOR_ID

### Railway
1. Go to railway.app
2. New Project → Deploy from GitHub repo
3. Add env vars

### Cloudflare Workers
See `worker.js` for Cloudflare Workers version.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/ticket` | POST | Create free ticket |
| `/api/ticket/:number` | GET | Get ticket details |
| `/api/pay/:number` | POST | Initiate PalmPesa payment |
| `/api/check-payment/:number` | POST | Check payment status |
| `/api/scan/:number` | POST | Guard scan ticket |
| `/api/queue` | GET | Queue statistics |
| `/api/webhook/palmpesa` | POST | PalmPesa webhook |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `PALMPESA_API_KEY` | Yes | PalmPesa API key |
| `PALMPESA_VENDOR_ID` | Yes | PalmPesa vendor ID |
| `FRONTEND_URL` | No | Frontend URL for CORS |

## Guard Login

- PIN: `1234`
- Can scan QR codes or enter ticket numbers manually

## License

MIT
