import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { openDb } = require('../src/db');
const { seed, DEMO_USERS } = require('../src/seed');
const { createApp } = require('../src/app');
const D = require('../src/domain');

let db, app;

async function login(role) {
  const u = DEMO_USERS.find((x) => x.role === role);
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: u.password });
  expect(res.status).toBe(200);
  return res.body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function createSubmittedOrder(supToken, qty = 50) {
  const res = await request(app).post('/api/orders').set(auth(supToken)).send({
    recipe_id: 1, target_qty: qty, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: 92, submit: true,
  });
  expect(res.status).toBe(201);
  return res.body.order;
}

const countsFor = (order, fn) => order.items.map((i) => ({ component_id: i.component_id, actual_qty: fn(i) }));

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp(db, { jwtSecret: 'test-secret', loginLimit: 1000 });
});

describe('Gatekeeper rules', () => {
  it('Test 1: all-GREEN order can be approved by an authenticated verifier', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const order = await createSubmittedOrder(sup);
    const save = await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver))
      .send({ counts: countsFor(order, (i) => i.expected_qty) });
    expect(save.status).toBe(200);
    expect(save.body.order.items.every((i) => i.status === 'GREEN')).toBe(true);

    const res = await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver)).send({});
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('VERIFIED');
    const log = res.body.order.logs[0];
    expect(log.decision).toBe('APPROVED');
    expect(log.verifier_name).toBe('Kasun Fernando');
    expect(log.timestamp).toBeTruthy();
    expect(log.wastage_pct).toBeCloseTo(2.22, 2); // (92-90)/90
  });

  it('Test 2: a RED (shortage) component blocks approval with 422', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const order = await createSubmittedOrder(sup);
    let first = true;
    await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver)).send({
      counts: countsFor(order, (i) => { if (first) { first = false; return i.expected_qty - 1; } return i.expected_qty; }),
    });
    const res = await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GATE_BLOCKED');
    expect(db.prepare('SELECT status FROM cutting_orders WHERE id = ?').get(order.id).status).toBe('PENDING_VERIFICATION');
    expect(db.prepare('SELECT COUNT(*) c FROM verification_logs').get().c).toBe(0);
  });

  it('blocks approval when components are uncounted, and ignores client-supplied status/verifier', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const order = await createSubmittedOrder(sup);
    const res = await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver))
      .send({ status: 'VERIFIED', verifier_id: 1, items: [], timestamp: '2020-01-01' });
    expect(res.status).toBe(422);

    // Even a tampered stored flag cannot get through: gate recomputes from raw counts.
    const item = order.items[0];
    db.prepare("UPDATE verification_items SET actual_qty = 0, status = 'GREEN' WHERE id = ?").run(item.id);
    for (const i of order.items.slice(1)) db.prepare('UPDATE verification_items SET actual_qty = ? WHERE id = ?').run(i.expected_qty, i.id);
    const res2 = await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver)).send({});
    expect(res2.status).toBe(422);
  });

  it('YELLOW (excess) batches may proceed', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const order = await createSubmittedOrder(sup);
    await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver))
      .send({ counts: countsFor(order, (i) => i.expected_qty + 3) });
    const res = await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver)).send({});
    expect(res.status).toBe(200);
    expect(res.body.order.logs[0].variance.every((v) => v.variance === 3 && v.status === 'YELLOW')).toBe(true);
  });

  it('Test 3: rejecting without a reason is rejected by backend validation', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const order = await createSubmittedOrder(sup);
    for (const body of [{}, { note: '' }, { note: '   ' }, { note: 'abc' }, { note: 123 }]) {
      const res = await request(app).post(`/api/orders/${order.id}/reject`).set(auth(ver)).send(body);
      expect(res.status).toBe(422);
    }
    expect(db.prepare('SELECT status FROM cutting_orders WHERE id = ?').get(order.id).status).toBe('PENDING_VERIFICATION');

    const ok = await request(app).post(`/api/orders/${order.id}/reject`).set(auth(ver)).send({ note: 'Collar short by 4 pieces' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.status).toBe('REJECTED');
    expect(ok.body.order.rejection_note).toBe('Collar short by 4 pieces');
  });

  it('Test 4: non-verifier roles receive 403 on approve and reject', async () => {
    const sup = await login('cutting_supervisor');
    const sew = await login('sewing_supervisor');
    const order = await createSubmittedOrder(sup);
    for (const t of [sup, sew]) {
      expect((await request(app).post(`/api/orders/${order.id}/approve`).set(auth(t)).send({})).status).toBe(403);
      expect((await request(app).post(`/api/orders/${order.id}/reject`).set(auth(t)).send({ note: 'not allowed here' })).status).toBe(403);
      expect((await request(app).put(`/api/orders/${order.id}/counts`).set(auth(t)).send({ counts: [] })).status).toBe(403);
    }
    expect((await request(app).post(`/api/orders/${order.id}/approve`).send({})).status).toBe(401);
  });

  it('Test 5: unapproved orders never appear in the sewing queue', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const sew = await login('sewing_supervisor');

    const draft = await request(app).post('/api/orders').set(auth(sup))
      .send({ recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-D-1', actual_fabric_yds: 19 });
    const pending = await createSubmittedOrder(sup, 20);
    const rejected = await createSubmittedOrder(sup, 30);
    await request(app).post(`/api/orders/${rejected.id}/reject`).set(auth(ver)).send({ note: 'Fabric defect on panels' });
    const good = await createSubmittedOrder(sup, 40);
    await request(app).put(`/api/orders/${good.id}/counts`).set(auth(ver)).send({ counts: countsFor(good, (i) => i.expected_qty) });
    await request(app).post(`/api/orders/${good.id}/approve`).set(auth(ver)).send({});

    const q1 = await request(app).get('/api/sewing/queue').set(auth(sew));
    expect(q1.status).toBe(200);
    expect(q1.body.orders.map((o) => o.id)).toEqual([good.id]);

    // Query-string tampering changes nothing.
    const q2 = await request(app).get('/api/sewing/queue?status=PENDING_VERIFICATION&all=1').set(auth(sew));
    expect(q2.body.orders.map((o) => o.id)).toEqual([good.id]);

    // Direct access to non-verified orders is a 404 for the sewing role, and /api/orders is 403.
    for (const o of [draft.body.order, pending, rejected]) {
      expect((await request(app).get(`/api/sewing/queue/${o.id}`).set(auth(sew))).status).toBe(404);
      expect((await request(app).post(`/api/sewing/${o.id}/start`).set(auth(sew))).status).toBe(404);
    }
    expect((await request(app).get('/api/orders').set(auth(sew))).status).toBe(403);
    expect((await request(app).get(`/api/orders/${pending.id}`).set(auth(sew))).status).toBe(403);
  });
});

describe('RBAC and state machine extras', () => {
  it('supervisor and verifier cannot reach the sewing queue; verifier cannot create orders', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    expect((await request(app).get('/api/sewing/queue').set(auth(sup))).status).toBe(403);
    expect((await request(app).get('/api/sewing/queue').set(auth(ver))).status).toBe(403);
    const res = await request(app).post('/api/orders').set(auth(ver))
      .send({ recipe_id: 1, target_qty: 5, fabric_roll_id: 'FAB-X-1', actual_fabric_yds: 9 });
    expect(res.status).toBe(403);
  });

  it('forged tokens and tampered roles are refused', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: 1, role: 'cutting_verifier' }, 'wrong-secret');
    expect((await request(app).get('/api/auth/me').set(auth(forged))).status).toBe(401);
    // Valid signature but claims a verifier role: role comes from the DB, so the supervisor stays a supervisor.
    const sup = db.prepare("SELECT id FROM users WHERE role = 'cutting_supervisor'").get();
    const tok = jwt.sign({ sub: sup.id, role: 'cutting_verifier' }, 'test-secret');
    const order = await createSubmittedOrder(await login('cutting_supervisor'));
    expect((await request(app).post(`/api/orders/${order.id}/approve`).set(auth(tok)).send({})).status).toBe(403);
  });

  it('computes expected component counts with the multiplier engine', async () => {
    const sup = await login('cutting_supervisor');
    const order = await createSubmittedOrder(sup, 50);
    const cuffs = order.items.find((i) => i.component_name === 'Sleeve Cuffs');
    expect(cuffs.expected_qty).toBe(100);
    expect(order.expected_fabric_yds).toBe(90);
  });

  it('rejects negative, decimal, non-numeric and empty inputs', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const base = { recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-ROLL-1', actual_fabric_yds: 20 };
    const bad = [
      { ...base, target_qty: -5 }, { ...base, target_qty: 2.5 }, { ...base, target_qty: '10' }, { ...base, target_qty: 0 },
      { ...base, actual_fabric_yds: -1 }, { ...base, actual_fabric_yds: 'abc' }, { ...base, fabric_roll_id: '' }, {},
    ];
    for (const b of bad) expect((await request(app).post('/api/orders').set(auth(sup)).send(b)).status).toBe(422);

    const order = await createSubmittedOrder(sup);
    const cid = order.items[0].component_id;
    for (const v of [-1, 1.5, 'x', null, '']) {
      const res = await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver)).send({ counts: [{ component_id: cid, actual_qty: v }] });
      expect(res.status).toBe(422);
    }
    expect((await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver)).send({})).status).toBe(422);
  });

  it('rejected batch returns to the supervisor, can be resubmitted, counts are reset; verified batches are immutable', async () => {
    const sup = await login('cutting_supervisor');
    const ver = await login('cutting_verifier');
    const sew = await login('sewing_supervisor');
    const order = await createSubmittedOrder(sup);
    await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver)).send({ counts: countsFor(order, () => 1) });
    await request(app).post(`/api/orders/${order.id}/reject`).set(auth(ver)).send({ note: 'Massive shortage on all parts' });

    const re = await request(app).post(`/api/orders/${order.id}/submit`).set(auth(sup)).send({ actual_fabric_yds: 95 });
    expect(re.status).toBe(200);
    expect(re.body.order.status).toBe('PENDING_VERIFICATION');
    expect(re.body.order.items.every((i) => i.actual_qty === null)).toBe(true);

    await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver)).send({ counts: countsFor(order, (i) => i.expected_qty) });
    expect((await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver)).send({})).status).toBe(200);

    // Cannot approve/reject/submit again, counts frozen.
    expect((await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver)).send({})).status).toBe(409);
    expect((await request(app).post(`/api/orders/${order.id}/reject`).set(auth(ver)).send({ note: 'changed my mind' })).status).toBe(409);
    expect((await request(app).post(`/api/orders/${order.id}/submit`).set(auth(sup)).send({})).status).toBe(409);
    expect((await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver)).send({ counts: countsFor(order, () => 0) })).status).toBe(409);

    // Audit trail is append-only at the database level.
    expect(() => db.prepare("UPDATE verification_logs SET wastage_pct = 0").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM verification_logs').run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE cutting_orders SET status = 'PENDING_VERIFICATION' WHERE id = ?").run(order.id)).toThrow(/illegal status/);

    // Sewing flow
    const start = await request(app).post(`/api/sewing/${order.id}/start`).set(auth(sew));
    expect(start.status).toBe(200);
    expect(start.body.order.status).toBe('SEWING_STARTED');
    expect((await request(app).get('/api/sewing/queue').set(auth(sew))).body.orders).toHaveLength(0);
    expect((await request(app).get('/api/sewing/in-progress').set(auth(sew))).body.orders).toHaveLength(1);
  });

  it('data persists in the database across app instances', async () => {
    const sup = await login('cutting_supervisor');
    const order = await createSubmittedOrder(sup);
    const app2 = createApp(db, { jwtSecret: 'test-secret' });
    const res = await request(app2).get(`/api/orders/${order.id}`).set(auth(sup));
    expect(res.status).toBe(200);
    expect(res.body.order.order_no).toMatch(/^CUT-\d{4}-0001$/);
  });
});

describe('domain helpers', () => {
  it('traffic light and wastage formulas', () => {
    expect(D.trafficLight(10, 10)).toBe('GREEN');
    expect(D.trafficLight(11, 10)).toBe('YELLOW');
    expect(D.trafficLight(9, 10)).toBe('RED');
    expect(D.trafficLight(0, 10)).toBe('RED');
    expect(D.trafficLight(null, 10)).toBeNull();
    expect(D.wastagePct(94.5, 90)).toBe(5);
    expect(D.wastagePct(85.5, 90)).toBe(-5);
  });
});
