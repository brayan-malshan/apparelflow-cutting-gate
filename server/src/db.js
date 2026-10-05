const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('cutting_supervisor','cutting_verifier','sewing_supervisor')),
  full_name     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_code      TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  std_fabric_yards REAL NOT NULL CHECK (std_fabric_yards > 0),
  wastage_cap      REAL NOT NULL CHECK (wastage_cap >= 0)
);

CREATE TABLE IF NOT EXISTS recipe_components (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id          INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  component_name     TEXT NOT NULL,
  pieces_per_garment INTEGER NOT NULL CHECK (pieces_per_garment > 0),
  image_url          TEXT
);

CREATE TABLE IF NOT EXISTS cutting_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no          TEXT NOT NULL UNIQUE,
  recipe_id         INTEGER NOT NULL REFERENCES recipes(id),
  target_qty        INTEGER NOT NULL CHECK (target_qty > 0),
  fabric_roll_id    TEXT NOT NULL,
  actual_fabric_yds REAL NOT NULL CHECK (actual_fabric_yds > 0),
  status            TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
                    CHECK (status IN ('CUTTING_IN_PROGRESS','PENDING_VERIFICATION','REJECTED','VERIFIED','SEWING_STARTED')),
  rejection_note    TEXT,
  created_by        INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verification_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES cutting_orders(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES recipe_components(id),
  expected_qty INTEGER NOT NULL,
  actual_qty   INTEGER,
  status       TEXT CHECK (status IN ('GREEN','YELLOW','RED')),
  UNIQUE (order_id, component_id)
);

CREATE TABLE IF NOT EXISTS verification_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES cutting_orders(id),
  verifier_id    INTEGER NOT NULL REFERENCES users(id),
  decision       TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  rejection_note TEXT,
  wastage_pct    REAL NOT NULL,
  variance_json  TEXT NOT NULL,
  timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON cutting_orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order ON verification_items(order_id);
CREATE INDEX IF NOT EXISTS idx_logs_order ON verification_logs(order_id);

-- Audit trail is append-only: block edits and deletes at the database level.
CREATE TRIGGER IF NOT EXISTS trg_logs_no_update BEFORE UPDATE ON verification_logs
BEGIN SELECT RAISE(ABORT, 'verification_logs is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_logs_no_delete BEFORE DELETE ON verification_logs
BEGIN SELECT RAISE(ABORT, 'verification_logs is immutable'); END;

-- Counts are only editable while the batch sits at the QC station. Once it is decided or released,
-- the item rows are frozen at the database level as well as in the API.
CREATE TRIGGER IF NOT EXISTS trg_items_frozen_update BEFORE UPDATE ON verification_items
WHEN (SELECT status FROM cutting_orders WHERE id = OLD.order_id) NOT IN ('PENDING_VERIFICATION','CUTTING_IN_PROGRESS')
BEGIN SELECT RAISE(ABORT, 'verification_items are frozen once the batch is decided'); END;
CREATE TRIGGER IF NOT EXISTS trg_items_no_delete_released BEFORE DELETE ON verification_items
WHEN (SELECT status FROM cutting_orders WHERE id = OLD.order_id) IN ('VERIFIED','SEWING_STARTED')
BEGIN SELECT RAISE(ABORT, 'verification_items are frozen once the batch is decided'); END;

-- A VERIFIED batch can never be moved back or sideways except into SEWING_STARTED.
CREATE TRIGGER IF NOT EXISTS trg_orders_state_guard BEFORE UPDATE OF status ON cutting_orders
WHEN OLD.status = 'VERIFIED' AND NEW.status NOT IN ('VERIFIED','SEWING_STARTED')
BEGIN SELECT RAISE(ABORT, 'illegal status transition from VERIFIED'); END;
CREATE TRIGGER IF NOT EXISTS trg_orders_sewing_final BEFORE UPDATE OF status ON cutting_orders
WHEN OLD.status = 'SEWING_STARTED' AND NEW.status <> 'SEWING_STARTED'
BEGIN SELECT RAISE(ABORT, 'illegal status transition from SEWING_STARTED'); END;
`;

const FALLBACK = path.join(__dirname, '..', 'data', 'apparelflow.db');

function resolveTarget(file) {
  const target = file || process.env.DATABASE_FILE || FALLBACK;
  if (target === ':memory:') return target;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    return target;
  } catch (e) {
    // Do not crash on boot when the configured volume is missing (for example no disk attached).
    console.warn(`[warn] Cannot use DATABASE_FILE "${target}" (${e.code}). Falling back to ${FALLBACK}. ` +
      'Data will NOT survive a restart unless this path is on a persistent volume.');
    fs.mkdirSync(path.dirname(FALLBACK), { recursive: true });
    return FALLBACK;
  }
}

function openDb(file) {
  const target = resolveTarget(file);
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, SCHEMA };
