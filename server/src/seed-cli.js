const { openDb } = require('./db');
const { seed } = require('./seed');

const db = openDb();
seed(db);
console.log('Database seeded.');
