# PrintNest backend starter

This is a runnable backend foundation for the PrintNest dual business model:
1. Customers place online print orders.
2. Print shops create merchant accounts and use the order workflow.
3. SaaS plan pricing is exposed through `/api/plans`.
4. Optional Razorpay order creation and payment signature verification are included.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set a long random `JWT_SECRET`. Start the server:

```bash
npm run dev
```

Health check: `http://localhost:4000/api/health`

SQLite database and uploaded files are stored locally by default in `data/` and `uploads/`.

## Main API routes

- `GET /api/health`
- `GET /api/plans`
- `GET /api/pricing/estimate?product=document&quantity=100&color_mode=bw&sides=single`
- `POST /api/auth/register` JSON: `{ "name":"Asha", "email":"asha@example.com", "password":"at-least-8-chars", "accountType":"merchant", "shopName":"Asha Prints" }`
- `POST /api/auth/login` JSON: `{ "email":"asha@example.com", "password":"..." }`
- `GET /api/auth/me` with `Authorization: Bearer <token>`
- `POST /api/orders` multipart/form-data with bearer token and fields `product`, `quantity`, `color_mode`, `sides`, optional `size`, `notes`, and optional file field named `file`
- `GET /api/orders` with bearer token
- `PATCH /api/orders/:id/status` JSON `{ "status":"printing" }` with merchant/admin token
- `POST /api/payments/create-order` JSON `{ "orderId":"PN-..." }`
- `POST /api/payments/verify` with Razorpay's `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`
- `POST /api/payments/webhook` for Razorpay webhooks
- `GET /api/admin/summary` and `GET /api/admin/users` (admin only)

Allowed upload extensions: PDF, JPG, JPEG, PNG, DOC, DOCX. Default max upload is 25 MB.

## Important setup notes

- This is a backend starter, not a live deployed production service. No payment can be accepted until you configure Razorpay keys, add the frontend checkout integration, set up the webhook in Razorpay, and test in test mode.
- For production, use managed PostgreSQL instead of local SQLite when deploying multiple server instances; use private object storage (e.g. S3-compatible storage) for customer files; add email/SMS notifications, password reset, email verification, audit logs, backups, and automated tests.
- Do not commit `.env` or real payment keys.
- Create the first administrator securely: register a normal account, then run this command against your database in a trusted environment:
  `UPDATE users SET role='admin' WHERE email='your-admin-email@example.com';`
- Configure real print rates in `priceOrder()` before taking customer orders. The included prices are illustrative only.
- SaaS plans are listed for display; subscription billing and recurring renewals are not yet wired to a payment provider.
- Validate file content with a malware scanner and consider storing files outside the web root before production.
- Use HTTPS in production and set `FRONTEND_ORIGIN` to the exact frontend domain.
