# Vending machine module

The vending module is a Cloudflare Workers/D1 port of the feature-rich Discord
vending implementation supplied for this project.

## Implemented features

- Multiple vending machines per Discord server/owner
- PayPay / Kyash prices per product
- Finite stock
  - one line = one stock item
  - paste stock from the dashboard
  - import TXT from iPhone/Files
  - large imports are chunked
  - inspect current stock
  - withdraw stock
- Infinite stock with reusable delivery content
- Stock reservation before payment
  - finite stock is reserved for 10 minutes
  - expired unpaid orders return stock automatically
  - conditional D1 updates prevent two buyers from receiving the same item
- Sales counters
- Fixed-yen coupons
- Custom product emoji
- Custom vending panel title / description / image URL
- Install a vending panel into a Discord channel
- Update an existing panel from its Discord message URL
- Public purchase log
- Per-server purchase log
- Private purchase log with delivered stock attached as TXT
- Optional role grant after purchase
- Stock-add notifications with role mention
- PayPay login + OTP
- Kyash login + OTP
- Used payment-link protection
- Payment amount verification before delivery
- PayPay pending-state recheck from Cloudflare Cron
- Retryable delivery when buyer DMs are closed
- Encrypted payment credentials in D1
- Web management UI

## Purchase flow

```text
Vending panel
  -> choose PayPay / Kyash
  -> choose product
  -> quantity + optional coupon
  -> reserve finite stock
  -> show final price
  -> buyer submits payment link
  -> verify link + amount
  -> receive/confirm payment
  -> claim delivery exactly once
  -> DM product / grant role / write logs
  -> mark stock sold + increment sales
```

A reused payment link is rejected. A finite-stock order that is not paid before
the reservation expires is released back into inventory.

## Storage changes from the supplied implementation

The original implementation stores configuration in JSON and finite inventory
in local TXT files. That model is not suitable for Cloudflare Workers, so the
port stores data in D1:

- `vending_machines`
- `vending_products`
- `vending_stock`
- `vending_coupons`
- `vending_stock_notifications`
- `vending_orders`
- `vending_payment_accounts`
- `vending_payment_login_challenges`
- `vending_used_payment_links`

This also lets the implementation use conditional stock reservations rather
than editing one shared local file.

## Payment-account security

Payment credentials are never placed in GitHub Pages or committed to the
repository. The dashboard sends them over HTTPS to the Worker and D1 stores
sensitive values encrypted with AES-GCM using the Worker secret
`SESSION_ENCRYPTION_KEY`.

Do not expose that Worker secret in client-side code.

## PayPay compatibility note

The supplied implementation uses PayPay application/private endpoints for
login and P2P link handling, not the PayPay Open Payment API. These endpoints
are not a stable public contract and may change. The port keeps payment logic
isolated in `apps/worker/src/vending-payments.ts` so it can be replaced
without rewriting the stock/order system.

The supplied implementation also has an optional arbitrary HTTP proxy setting.
Cloudflare Workers does not expose the same `aiohttp proxy=` behavior, so
that one feature is intentionally not faked in the Worker port.

## Kyash compatibility note

The supplied bot references the external Kyasher implementation. The Worker
port reproduces the relevant login/OTP/link-check/link-receive HTTP flow in an
adapter rather than bundling that Python package.

## Main files

- `apps/worker/src/vending-db.ts` — D1 model, stock reservation, coupons, orders
- `apps/worker/src/vending-payments.ts` — PayPay/Kyash adapters
- `apps/worker/src/vending.ts` — Web API + Discord interaction purchase flow
- `apps/web/src/VendingManager.tsx` — Web dashboard
