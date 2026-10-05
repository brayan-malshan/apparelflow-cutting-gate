import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { openDb } = require('../src/db');
const { seed, DEMO_USERS } = require('../src/seed');
const { createApp } = require('../src/app');

let db, app;
const cred = (role) => DEMO_USERS.find((u) => u.role === role);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
async function login(role, ip = '203.0.113.7') {
  const u = cred(role);
  return request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email: u.email, password: u.password });
}
const token = async (role) => (await login(role)).body.token;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp(db, { jwtSecret: 'test-secret' }); // default login limit (10 failures / minute)
});

describe('login rate limit', () => {
  it('role switching (successful logins) never trips the limiter, even from one shared proxy IP', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await login(['cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'][i % 3]);
      expect(res.status).toBe(200);
    }
  });

  it('repeated failures are throttled per client IP + email, and other clients are unaffected', async () => {
    const bad = (ip) => request(app).post('/api/auth/login').set('X-Forwarded-For', ip)
      .send({ email: cred('cutting_verifier').email, password: 'wrong-password' });
    for (let i = 0; i < 10; i++) expect((await bad('198.51.100.1')).status).toBe(401);
    expect((await bad('198.51.100.1')).status).toBe(429);
    // A different client behind the same proxy is still served.
    expect((await bad('198.51.100.2')).status).toBe(401);
    expect((await login('cutting_supervisor', '198.51.100.1')).status).toBe(200);
  });
});

describe('database freezes counts once a batch is decided', () => {
  it('blocks UPDATE/DELETE on verification_items after approval or rejection', async () => {
    const sup = await token('cutting_supervisor');
    const ver = await token('cutting_verifier');
    const create = await request(app).post('/api/orders').set(auth(sup))
      .send({ recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-T-1', actual_fabric_yds: 18, submit: true });
    const order = create.body.order;
    await request(app).put(`/api/orders/${order.id}/counts`).set(auth(ver))
      .send({ counts: order.items.map((i) => ({ component_id: i.component_id, actual_qty: i.expected_qty })) });
    await request(app).post(`/api/orders/${order.id}/approve`).set(auth(ver));
    expect(() => db.prepare('UPDATE verification_items SET actual_qty = 0 WHERE order_id = ?').run(order.id)).toThrow(/frozen/);
    expect(() => db.prepare('DELETE FROM verification_items WHERE order_id = ?').run(order.id)).toThrow(/frozen/);

    const rej = await request(app).post('/api/orders').set(auth(sup))
      .send({ recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-T-2', actual_fabric_yds: 18, submit: true });
    await request(app).post(`/api/orders/${rej.body.order.id}/reject`).set(auth(ver)).send({ note: 'Fabric flaw on roll end' });
    expect(() => db.prepare('UPDATE verification_items SET actual_qty = 5 WHERE order_id = ?').run(rej.body.order.id)).toThrow(/frozen/);
  });
});

describe('editing drafts', () => {
  it('supervisor can edit a draft; expected counts follow the new quantity; submitted orders cannot be edited', async () => {
    const sup = await token('cutting_supervisor');
    const ver = await token('cutting_verifier');
    const create = await request(app).post('/api/orders').set(auth(sup))
      .send({ recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-D-1', actual_fabric_yds: 18 });
    const id = create.body.order.id;
    expect(create.body.order.status).toBe('CUTTING_IN_PROGRESS');

    const edit = await request(app).put(`/api/orders/${id}`).set(auth(sup))
      .send({ target_qty: 50, fabric_roll_id: 'fab-roll-882', actual_fabric_yds: 92.5 });
    expect(edit.status).toBe(200);
    expect(edit.body.order.target_qty).toBe(50);
    expect(edit.body.order.fabric_roll_id).toBe('FAB-ROLL-882');
    expect(edit.body.order.items.find((i) => i.component_name === 'Sleeve Cuffs').expected_qty).toBe(100);

    for (const bad of [{ target_qty: -1 }, { target_qty: 2.5 }, {}]) {
      const r = await request(app).put(`/api/orders/${id}`).set(auth(sup)).send({ fabric_roll_id: 'FAB-D-1', actual_fabric_yds: 5, ...bad });
      expect(r.status).toBe(422);
    }
    expect((await request(app).put(`/api/orders/${id}`).set(auth(ver)).send({ target_qty: 5, fabric_roll_id: 'FAB-D-1', actual_fabric_yds: 5 })).status).toBe(403);

    await request(app).post(`/api/orders/${id}/submit`).set(auth(sup)).send({});
    const after = await request(app).put(`/api/orders/${id}`).set(auth(sup)).send({ target_qty: 5, fabric_roll_id: 'FAB-D-1', actual_fabric_yds: 5 });
    expect(after.status).toBe(409);
  });
});

describe('98 of 100 cuffs scenario (shortage hard stop)', () => {
  it('Casual Blouse x50: 98/100 cuffs is RED, approval gets 422, nothing reaches sewing', async () => {
    const sup = await token('cutting_supervisor');
    const ver = await token('cutting_verifier');
    const sew = await token('sewing_supervisor');
    const { body } = await request(app).post('/api/orders').set(auth(sup))
      .send({ recipe_id: 1, target_qty: 50, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: 92, submit: true });
    const counts = body.order.items.map((i) => ({
      component_id: i.component_id, actual_qty: i.component_name === 'Sleeve Cuffs' ? 98 : i.expected_qty,
    }));
    const saved = await request(app).put(`/api/orders/${body.order.id}/counts`).set(auth(ver)).send({ counts });
    const cuffs = saved.body.order.items.find((i) => i.component_name === 'Sleeve Cuffs');
    expect(cuffs).toMatchObject({ expected_qty: 100, actual_qty: 98, status: 'RED' });
    expect(saved.body.gate).toBe(false);

    const approve = await request(app).post(`/api/orders/${body.order.id}/approve`).set(auth(ver));
    expect(approve.status).toBe(422);
    expect(approve.body.error.fields.red).toEqual(['Sleeve Cuffs']);
    expect((await request(app).get('/api/sewing/queue').set(auth(sew))).body.orders).toHaveLength(0);
  });
});

describe('boot safety', () => {
  it('falls back instead of crashing when DATABASE_FILE points at an unusable directory', () => {
    const d = openDb('/etc/hostname/not-a-directory/apparelflow.db');
    expect(d.prepare('SELECT COUNT(*) c FROM sqlite_master').get().c).toBeGreaterThan(0);
    d.close();
  });
});
