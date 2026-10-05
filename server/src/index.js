const crypto = require('crypto');
const { openDb } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');

let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET not set - using a random secret; sessions reset on every restart.');
}

const db = openDb();
seed(db);

const port = Number(process.env.PORT) || 4000;
createApp(db, { jwtSecret: secret }).listen(port, () => {
  console.log(`ApparelFlow listening on http://localhost:${port}`);
});
