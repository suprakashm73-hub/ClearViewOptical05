# ClearView Opticals – spectacle shop (backend + database)

Express server + SQLite database + the shop website. Customers log in with mobile number and password; the admin has a separate login.

## Run on your computer
1. Install Node.js 22.13 or newer from https://nodejs.org
2. Open a terminal in this folder and run: `npm install`
3. Copy `.env.example` to `.env` and set `JWT_SECRET` (any long random text). Optionally set `ADMIN_USER` and `ADMIN_PASSWORD`.
4. Run: `npm start`
5. Open http://localhost:3000 in Chrome.

On the very first run the terminal shows the admin username and password (unless you set ADMIN_PASSWORD). Admin login is the link at the bottom of the shop. You can change the password in Admin panel > Settings.

## Where things are
- `server.js` – all backend code and API routes
- `public/index.html` – the website customers and admin see
- `shop.db` – the database file, created automatically (users, products, orders, settings). Back it up regularly.

## Put it on the internet
Use a host that can run Node.js and keeps files on a permanent disk (a small VPS, Render with a disk, Railway with a volume). Set `NODE_ENV=production` and the same `.env` values, and serve over HTTPS (the host usually does this). Without a permanent disk, shop.db is erased on each deploy.

## Not included yet (add before taking real money)
- **SMS OTP** to verify mobile numbers (e.g. MSG91, Twilio). Currently anyone can register any number.
- **Online payment gateway** (e.g. Razorpay, Cashfree). “Online payment” orders are saved as pending. Cash on delivery and QR (manual check of the transaction ID in Admin > Orders) work now.
- Forgot-password flow, email/SMS order notifications, product photo upload.

## Managing products (admin)
Admin panel > Products > Edit (or + Add product) lets you change the name, price, stock, category, description and **photo**. Photos are resized in the browser and stored in the database. Existing shop.db files are upgraded automatically when you restart the server.

## New features
- **Customer service**: Admin > Settings > Customer service numbers (up to 3). Customers see a floating "Help" button with Call, WhatsApp and SMS buttons.
- **Reviews and ratings**: a customer can review a product (1-5 stars, feedback, optional photo) only after the admin marks their order **Delivered**. Star ratings show on every product card. Admin > Reviews lets you delete a review.
- **Colour choices**: Admin > Products > Edit > Colour options (up to 8 per model, first one is the default). Customers pick a colour on the card or product page; the colour is saved in the order.
- **Online payment**: choosing "Online payment" shows the QR and UPI ID uploaded in Admin > Settings, a "Pay with UPI app" button on phones, and requires the UPI transaction ID. If no QR is uploaded, only cash on delivery is offered.
- Existing `shop.db` files are upgraded automatically on restart.
