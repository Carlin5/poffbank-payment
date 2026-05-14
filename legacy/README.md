# Legacy / DO NOT DEPLOY

Everything in this directory is the original PoffBank prototype. It is kept
**for reference only**. Do not deploy it and do not serve any file from here.

## Why it's quarantined

- `server.js` collected raw card numbers, CVVs and expiry dates and stored them
  in process memory (PCI-DSS violation).
- `server.js` claimed Flutterwave charges would trigger NOWPayments USDT
  payouts. They don't — those are unrelated money rails. Real payments would
  silently fail; "simulation mode" lied to customers.
- `index.html`, `checkout.html`, `dashboard.html`, `script.js`, `styles.css`
  rendered the card-collection UI that fed `server.js`.

## The current, supported app

- `../server-clean.js` (run with `npm start` from the repo root)
- `../public/pay.html`
- `../public/success.html`
- `../public/cancel.html`

It uses NOWPayments' **hosted invoice** flow: no card data ever touches our
server, status is verified with a signed IPN, and settlement is on-chain.
