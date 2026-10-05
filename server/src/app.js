const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const D = require('./domain');

const MAX_COUNT = 1_000_000;
const MAX_NOTE = 500;
const MIN_NOTE = 5;

class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (e) {
    next(e);
  }
};

function createApp(db, opts = {}) {
  const secret = opts.jwtSecret || process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT secret is required');
  const app = express();
  app.disable('x-powered-by');
  // Behind Render/Railway/Fly every request arrives via one proxy; trust exactly one hop so req.ip is the real client.
  app.set('trust proxy', opts.trustProxy ?? (process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1));
  // upgrade-insecure-requests is dropped so the built client still loads over plain http://localhost.
  // Hosting platforms terminate TLS in front of this app, so production traffic is https anyway.
  app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'upgrade-insecure-requests': null } } }));
  app.use(express.json({ limit: '50kb' }));

  // ---------- statements ----------
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, role, full_name, created_at FROM users WHERE id = ?'),
    recipes: db.prepare('SELECT * FROM recipes ORDER BY recipe_code'),
    recipe: db.prepare('SELECT * FROM recipes WHERE id = ?'),
    recipeComps: db.prepare('SELECT * FROM recipe_components WHERE recipe_id = ? ORDER BY id'),
    insertOrder: db.prepare(`INSERT INTO cutting_orders
      (order_no, recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, status, created_by)
      VALUES (?,?,?,?,?,?,?)`),
    insertItem: db.prepare('INSERT INTO verification_items (order_id, component_id, expected_qty) VALUES (?,?,?)'),
    nextOrderId: db.prepare("SELECT COALESCE(MAX(id),0)+1 AS n FROM cutting_orders"),
    order: db.prepare('SELECT * FROM cutting_orders WHERE id = ?'),
    setStatus: db.prepare("UPDATE cutting_orders SET status = ?, rejection_note = ?, updated_at = datetime('now') WHERE id = ?"),
    resubmit: db.prepare(`UPDATE cutting_orders SET status = 'PENDING_VERIFICATION', rejection_note = NULL,
      fabric_roll_id = ?, actual_fabric_yds = ?, updated_at = datetime('now') WHERE id = ?`),
    items: db.prepare(`SELECT vi.id, vi.order_id, vi.component_id, rc.component_name, rc.pieces_per_garment,
      vi.expected_qty, vi.actual_qty, vi.status
      FROM verification_items vi JOIN recipe_components rc ON rc.id = vi.component_id
      WHERE vi.order_id = ? ORDER BY rc.id`),
    saveCount: db.prepare('UPDATE verification_items SET actual_qty = ?, status = ? WHERE order_id = ? AND component_id = ?'),
    resetItems: db.prepare('UPDATE verification_items SET actual_qty = NULL, status = NULL WHERE order_id = ?'),
    insertLog: db.prepare(`INSERT INTO verification_logs
      (order_id, verifier_id, decision, rejection_note, wastage_pct, variance_json) VALUES (?,?,?,?,?,?)`),
    logsForOrder: db.prepare(`SELECT vl.*, u.full_name AS verifier_name FROM verification_logs vl
      JOIN users u ON u.id = vl.verifier_id WHERE vl.order_id = ? ORDER BY vl.id DESC`),
  };

  const ORDER_SELECT = `SELECT o.*, r.recipe_code, r.name AS recipe_name, r.category, r.std_fabric_yards, r.wastage_cap,
      u.full_name AS created_by_name
    FROM cutting_orders o JOIN recipes r ON r.id = o.recipe_id JOIN users u ON u.id = o.created_by`;

  const decorate = (o) => {
    const expectedYds = D.expectedFabric(o.target_qty, o.std_fabric_yards);
    const pct = D.wastagePct(o.actual_fabric_yds, expectedYds);
    return {
      ...o,
      expected_fabric_yds: Math.round(expectedYds * 100) / 100,
      projected_wastage_pct: pct,
      over_wastage_cap: pct > o.wastage_cap,
    };
  };

  const loadOrderFull = (id) => {
    const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
    if (!o) return null;
    return { ...decorate(o), items: q.items.all(id), logs: q.logsForOrder.all(id).map(parseLog) };
  };

  const parseLog = (l) => ({ ...l, variance: JSON.parse(l.variance_json), variance_json: undefined });

  // ---------- auth ----------
  // Only FAILED logins count towards the limit, so demo role-switching never locks anyone out.
  const failedLogins = new Map();
  const failuresIn = (key) => {
    const now = Date.now();
    const rec = (failedLogins.get(key) || []).filter((t) => now - t < 60_000);
    failedLogins.set(key, rec);
    return rec;
  };
  const assertNotThrottled = (key) => {
    if (failuresIn(key).length >= (opts.loginLimit || 10)) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts. Try again in a minute.');
    }
  };
  const recordFailure = (key) => failuresIn(key).push(Date.now());

  const authenticate = (req, _res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(new ApiError(401, 'UNAUTHENTICATED', 'Authentication required'));
    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch {
      return next(new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired session'));
    }
    // Identity AND role are always re-read from the database, never taken from the token claims.
    const user = q.userById.get(payload.sub);
    if (!user) return next(new ApiError(401, 'UNAUTHENTICATED', 'Account no longer exists'));
    req.user = user;
    next();
  };

  const requireRole = (...roles) => (req, _res, next) =>
    roles.includes(req.user.role)
      ? next()
      : next(new ApiError(403, 'FORBIDDEN', `Role "${req.user.role}" is not permitted to perform this action`));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', wrap((req, res) => {
    const { email, password } = req.body || {};
    const throttleKey = `${req.ip}|${typeof email === 'string' ? email.trim().toLowerCase() : ''}`;
    assertNotThrottled(throttleKey);
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      throw new ApiError(422, 'VALIDATION', 'Email and password are required', { email: !email ? 'Required' : undefined, password: !password ? 'Required' : undefined });
    }
    const user = q.userByEmail.get(email.trim().toLowerCase());
    // Compare against a dummy hash when the user is unknown so timing does not reveal valid emails.
    const hash = user ? user.password_hash : '$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BcxgGsC2r8J1Zj8k8VQz6l8W9m3K';
    const ok = bcrypt.compareSync(password, hash);
    if (!user || !ok) {
      recordFailure(throttleKey);
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Incorrect email or password');
    }
    failedLogins.delete(throttleKey);
    const token = jwt.sign({ sub: user.id }, secret, { algorithm: 'HS256', expiresIn: '8h' });
    res.json({ token, user: q.userById.get(user.id) });
  }));

  app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

  // ---------- recipes (read-only; recipes cannot be edited through the API) ----------
  app.get('/api/recipes', authenticate, requireRole(D.ROLES.SUPERVISOR, D.ROLES.VERIFIER), wrap((_req, res) => {
    res.json({ recipes: q.recipes.all().map((r) => ({ ...r, components: q.recipeComps.all(r.id) })) });
  }));

  // ---------- cutting orders ----------
  function validateOrderInput(body) {
    const errors = {};
    const { recipe_id, target_qty, fabric_roll_id, actual_fabric_yds } = body || {};
    if (!D.isPositiveInt(recipe_id)) errors.recipe_id = 'Choose a recipe';
    if (!D.isPositiveInt(target_qty)) errors.target_qty = 'Enter a whole number greater than 0';
    else if (target_qty > 100000) errors.target_qty = 'Maximum batch size is 100,000';
    if (typeof fabric_roll_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(fabric_roll_id.trim())) {
      errors.fabric_roll_id = 'Use 3-40 letters, digits, "-" or "_" (e.g. FAB-ROLL-882)';
    }
    if (!D.isPositiveYards(actual_fabric_yds)) errors.actual_fabric_yds = 'Enter yards greater than 0 (max 2 decimals)';
    if (Object.keys(errors).length) throw new ApiError(422, 'VALIDATION', 'Please fix the highlighted fields', errors);
    return { recipe_id, target_qty, fabric_roll_id: fabric_roll_id.trim().toUpperCase(), actual_fabric_yds };
  }

  app.post('/api/orders', authenticate, requireRole(D.ROLES.SUPERVISOR), wrap((req, res) => {
    const input = validateOrderInput(req.body);
    const submit = req.body.submit === true;
    const recipe = q.recipe.get(input.recipe_id);
    if (!recipe) throw new ApiError(422, 'VALIDATION', 'Please fix the highlighted fields', { recipe_id: 'Recipe does not exist' });

    const id = db.transaction(() => {
      const n = q.nextOrderId.get().n;
      const orderNo = `CUT-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
      const status = submit ? D.STATUS.PENDING_VERIFICATION : D.STATUS.CUTTING_IN_PROGRESS;
      const info = q.insertOrder.run(orderNo, recipe.id, input.target_qty, input.fabric_roll_id, input.actual_fabric_yds, status, req.user.id);
      for (const c of q.recipeComps.all(recipe.id)) {
        q.insertItem.run(info.lastInsertRowid, c.id, D.expectedQty(input.target_qty, c.pieces_per_garment));
      }
      return info.lastInsertRowid;
    })();
    res.status(201).json({ order: loadOrderFull(id) });
  }));

  // Supervisor can correct a draft until it is submitted. Recipe is fixed; quantity change recomputes expected counts.
  app.put('/api/orders/:id', authenticate, requireRole(D.ROLES.SUPERVISOR), wrap((req, res) => {
    const order = q.order.get(Number(req.params.id));
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
    if (order.status !== D.STATUS.CUTTING_IN_PROGRESS) {
      throw new ApiError(409, 'ILLEGAL_TRANSITION', 'Only drafts that are still cutting can be edited');
    }
    const input = validateOrderInput({ ...req.body, recipe_id: order.recipe_id });
    db.transaction(() => {
      db.prepare(`UPDATE cutting_orders SET target_qty = ?, fabric_roll_id = ?, actual_fabric_yds = ?,
        updated_at = datetime('now') WHERE id = ? AND status = 'CUTTING_IN_PROGRESS'`)
        .run(input.target_qty, input.fabric_roll_id, input.actual_fabric_yds, order.id);
      for (const c of q.recipeComps.all(order.recipe_id)) {
        db.prepare('UPDATE verification_items SET expected_qty = ? WHERE order_id = ? AND component_id = ?')
          .run(D.expectedQty(input.target_qty, c.pieces_per_garment), order.id, c.id);
      }
    })();
    res.json({ order: loadOrderFull(order.id) });
  }));

  app.get('/api/orders', authenticate, requireRole(D.ROLES.SUPERVISOR, D.ROLES.VERIFIER), wrap((req, res) => {
    // Verifiers never see drafts that are still on the cutting table.
    const where = req.user.role === D.ROLES.VERIFIER ? "WHERE o.status <> 'CUTTING_IN_PROGRESS'" : '';
    const rows = db.prepare(`${ORDER_SELECT} ${where} ORDER BY o.id DESC`).all().map(decorate);
    res.json({ orders: rows });
  }));

  app.get('/api/orders/:id', authenticate, requireRole(D.ROLES.SUPERVISOR, D.ROLES.VERIFIER), wrap((req, res) => {
    const order = loadOrderFull(Number(req.params.id));
    if (!order || (req.user.role === D.ROLES.VERIFIER && order.status === D.STATUS.CUTTING_IN_PROGRESS)) {
      throw new ApiError(404, 'NOT_FOUND', 'Order not found');
    }
    res.json({ order });
  }));

  function getOrderOr404(idParam) {
    const o = q.order.get(Number(idParam));
    if (!o) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
    return o;
  }

  // Supervisor submits a draft, or resubmits a rejected batch after re-cutting.
  app.post('/api/orders/:id/submit', authenticate, requireRole(D.ROLES.SUPERVISOR), wrap((req, res) => {
    const order = getOrderOr404(req.params.id);
    if (!D.canTransition(order.status, D.STATUS.PENDING_VERIFICATION)) {
      throw new ApiError(409, 'ILLEGAL_TRANSITION', `Cannot submit an order that is ${order.status}`);
    }
    db.transaction(() => {
      if (order.status === D.STATUS.REJECTED) {
        const input = validateOrderInput({
          recipe_id: order.recipe_id, target_qty: order.target_qty,
          fabric_roll_id: req.body?.fabric_roll_id ?? order.fabric_roll_id,
          actual_fabric_yds: req.body?.actual_fabric_yds ?? order.actual_fabric_yds,
        });
        // Status first: the items trigger only allows edits while the batch is at QC.
        q.resubmit.run(input.fabric_roll_id, input.actual_fabric_yds, order.id);
        q.resetItems.run(order.id); // re-cut batch must be fully recounted
      } else {
        q.setStatus.run(D.STATUS.PENDING_VERIFICATION, null, order.id);
      }
    })();
    res.json({ order: loadOrderFull(order.id) });
  }));

  // ---------- verifier terminal ----------
  app.put('/api/orders/:id/counts', authenticate, requireRole(D.ROLES.VERIFIER), wrap((req, res) => {
    const order = getOrderOr404(req.params.id);
    if (order.status !== D.STATUS.PENDING_VERIFICATION) {
      throw new ApiError(409, 'ILLEGAL_TRANSITION', 'Counts can only be recorded while the batch is pending verification');
    }
    const counts = req.body?.counts;
    if (!Array.isArray(counts) || counts.length === 0) {
      throw new ApiError(422, 'VALIDATION', 'Provide at least one component count', { counts: 'Required' });
    }
    const items = new Map(q.items.all(order.id).map((i) => [i.component_id, i]));
    const errors = {};
    const seen = new Set();
    for (const c of counts) {
      const key = c && c.component_id;
      if (!items.has(key)) { errors.counts = 'Unknown component in payload'; break; }
      if (seen.has(key)) { errors.counts = 'Duplicate component in payload'; break; }
      seen.add(key);
      if (!D.isNonNegativeInt(c.actual_qty) || c.actual_qty > MAX_COUNT) {
        errors[`component_${key}`] = 'Enter a whole number, 0 or more (no decimals or negatives)';
      }
    }
    if (Object.keys(errors).length) throw new ApiError(422, 'VALIDATION', 'Please fix the highlighted counts', errors);

    db.transaction(() => {
      for (const c of counts) {
        const it = items.get(c.component_id);
        q.saveCount.run(c.actual_qty, D.trafficLight(c.actual_qty, it.expected_qty), order.id, c.component_id);
      }
    })();
    const items2 = q.items.all(order.id);
    res.json({ order: loadOrderFull(order.id), gate: D.evaluateGate(items2).canApprove });
  }));

  app.post('/api/orders/:id/approve', authenticate, requireRole(D.ROLES.VERIFIER), wrap((req, res) => {
    // Nothing from the body is used: verifier = session user, timestamp = server clock,
    // counts = rows already stored in the database.
    const id = Number(req.params.id);
    const result = db.transaction(() => {
      const order = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
      if (!D.canTransition(order.status, D.STATUS.VERIFIED)) {
        throw new ApiError(409, 'ILLEGAL_TRANSITION', `Cannot approve an order that is ${order.status}`);
      }
      const items = q.items.all(id);
      const gate = D.evaluateGate(items);
      if (!gate.canApprove) {
        const parts = [];
        if (gate.red.length) parts.push(`shortage on: ${gate.red.map((i) => i.component_name).join(', ')}`);
        if (gate.uncounted.length) parts.push(`not counted: ${gate.uncounted.map((i) => i.component_name).join(', ')}`);
        throw new ApiError(422, 'GATE_BLOCKED', `Approval blocked - ${parts.join('; ') || 'no components to verify'}`, {
          red: gate.red.map((i) => i.component_name),
          uncounted: gate.uncounted.map((i) => i.component_name),
        });
      }
      // Normalise stored flags from the recomputed values before sealing the record.
      for (const i of items) q.saveCount.run(i.actual_qty, D.trafficLight(i.actual_qty, i.expected_qty), id, i.component_id);
      const expectedYds = D.expectedFabric(order.target_qty, order.std_fabric_yards);
      const pct = D.wastagePct(order.actual_fabric_yds, expectedYds);
      const variance = items.map((i) => ({
        component_id: i.component_id, component_name: i.component_name,
        expected_qty: i.expected_qty, actual_qty: i.actual_qty, variance: i.actual_qty - i.expected_qty,
        status: D.trafficLight(i.actual_qty, i.expected_qty),
      }));
      q.insertLog.run(id, req.user.id, 'APPROVED', null, pct, JSON.stringify(variance));
      q.setStatus.run(D.STATUS.VERIFIED, null, id);
      return id;
    }).immediate();
    res.json({ order: loadOrderFull(result) });
  }));

  app.post('/api/orders/:id/reject', authenticate, requireRole(D.ROLES.VERIFIER), wrap((req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length < MIN_NOTE || note.length > MAX_NOTE) {
      throw new ApiError(422, 'VALIDATION', 'A rejection reason is mandatory', {
        note: `Enter a reason between ${MIN_NOTE} and ${MAX_NOTE} characters`,
      });
    }
    const id = Number(req.params.id);
    db.transaction(() => {
      const order = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
      if (!D.canTransition(order.status, D.STATUS.REJECTED)) {
        throw new ApiError(409, 'ILLEGAL_TRANSITION', `Cannot reject an order that is ${order.status}`);
      }
      const items = q.items.all(id);
      const pct = D.wastagePct(order.actual_fabric_yds, D.expectedFabric(order.target_qty, order.std_fabric_yards));
      const variance = items.map((i) => ({
        component_id: i.component_id, component_name: i.component_name,
        expected_qty: i.expected_qty, actual_qty: i.actual_qty,
        variance: i.actual_qty === null ? null : i.actual_qty - i.expected_qty,
        status: D.trafficLight(i.actual_qty, i.expected_qty),
      }));
      q.insertLog.run(id, req.user.id, 'REJECTED', note, pct, JSON.stringify(variance));
      q.setStatus.run(D.STATUS.REJECTED, note, id);
    }).immediate();
    res.json({ order: loadOrderFull(id) });
  }));

  // ---------- sewing floor ----------
  // The status literal is hard-coded in SQL. No request parameter can widen this filter.
  const sewingList = (status) => db.prepare(`${ORDER_SELECT} WHERE o.status = '${status}' ORDER BY o.updated_at DESC, o.id DESC`);
  const queueStmt = sewingList('VERIFIED');
  const startedStmt = sewingList('SEWING_STARTED');
  const sewingDetail = (status) => db.prepare(`${ORDER_SELECT} WHERE o.id = ? AND o.status = '${status}'`);
  const queueDetailStmt = sewingDetail('VERIFIED');
  const startedDetailStmt = sewingDetail('SEWING_STARTED');

  const sewingView = (o) => {
    const log = q.logsForOrder.all(o.id).map(parseLog).find((l) => l.decision === 'APPROVED');
    return { ...decorate(o), items: q.items.all(o.id), approval: log || null };
  };

  app.get('/api/sewing/queue', authenticate, requireRole(D.ROLES.SEWING), wrap((_req, res) => {
    res.json({ orders: queueStmt.all().map(sewingView) });
  }));

  app.get('/api/sewing/in-progress', authenticate, requireRole(D.ROLES.SEWING), wrap((_req, res) => {
    res.json({ orders: startedStmt.all().map(sewingView) });
  }));

  app.get('/api/sewing/queue/:id', authenticate, requireRole(D.ROLES.SEWING), wrap((req, res) => {
    const id = Number(req.params.id);
    const o = queueDetailStmt.get(id) || startedDetailStmt.get(id);
    if (!o) throw new ApiError(404, 'NOT_FOUND', 'Order is not in the sewing queue');
    res.json({ order: sewingView(o) });
  }));

  app.post('/api/sewing/:id/start', authenticate, requireRole(D.ROLES.SEWING), wrap((req, res) => {
    const id = Number(req.params.id);
    db.transaction(() => {
      const o = queueDetailStmt.get(id);
      if (!o) throw new ApiError(404, 'NOT_FOUND', 'Order is not in the sewing queue');
      q.setStatus.run(D.STATUS.SEWING_STARTED, null, id);
    }).immediate();
    res.json({ order: sewingView(startedDetailStmt.get(id)) });
  }));

  // ---------- static client ----------
  const dist = opts.clientDist || path.join(__dirname, '..', '..', 'client', 'dist');
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Unknown API route')));
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // ---------- errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp, ApiError };
