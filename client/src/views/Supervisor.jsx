import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtTime, parseWhole, parseYards } from '../api.js';
import { Alert, Field, Modal, StatusBadge, fmtYds, fmtPct } from '../ui.jsx';
import { usePolling, timeLabel } from '../usePolling.js';

const STATUSES = [
  ['CUTTING_IN_PROGRESS', 'Cutting'],
  ['PENDING_VERIFICATION', 'At QC'],
  ['REJECTED', 'Rejected'],
  ['VERIFIED', 'Verified'],
  ['SEWING_STARTED', 'Sewing'],
];

export default function Supervisor() {
  const [orders, setOrders] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [resubmit, setResubmit] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([api('/orders'), api('/recipes')]);
      setOrders(o.orders);
      setRecipes(r.recipes);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const { refresh, updatedAt } = usePolling(load, 8000);

  const counts = useMemo(() => {
    const c = {};
    orders.forEach((o) => { c[o.status] = (c[o.status] || 0) + 1; });
    return c;
  }, [orders]);

  const submitDraft = async (o) => {
    try {
      await api(`/orders/${o.id}/submit`, { method: 'POST', body: {} });
      setNotice(`${o.order_no} sent to the verification terminal.`);
      refresh();
    } catch (e) { setError(e.message); }
  };

  const openDetail = async (o) => {
    try { setDetail((await api(`/orders/${o.id}`)).order); } catch (e) { setError(e.message); }
  };

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>Cutting orders</h1>
          <p className="muted" style={{ margin: 0 }}>Open orders from a production recipe and follow them through QC.</p>
        </div>
        <div className="row">
          {updatedAt && <span className="small muted">Updated {timeLabel(updatedAt)}</span>}
          <button className="secondary" onClick={refresh}>Refresh</button>
          <button onClick={() => { setNotice(''); setShowNew(true); }} disabled={!recipes.length}>+ New cutting order</button>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div className="tiles">
        {STATUSES.map(([s, label]) => (
          <div className="tile" key={s}><div className="n">{counts[s] || 0}</div><div className="l">{label}</div></div>
        ))}
      </div>

      <div className="card">
        {loading ? <div className="empty">Loading orders...</div> : orders.length === 0 ? (
          <div className="empty">No cutting orders yet. Create the first one with the button above.</div>
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr><th>Order</th><th>Recipe</th><th className="num">Qty</th><th>Fabric roll</th><th className="num">Fabric used</th><th className="num">Wastage</th><th>Status</th><th>Created</th><th /></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td data-label="Order"><button className="link mono" onClick={() => openDetail(o)}>{o.order_no}</button></td>
                    <td data-label="Recipe">{o.recipe_name}<div className="small muted">{o.recipe_code}</div></td>
                    <td className="num" data-label="Qty">{o.target_qty}</td>
                    <td className="mono" data-label="Fabric roll">{o.fabric_roll_id}</td>
                    <td className="num" data-label="Fabric used">{fmtYds(o.actual_fabric_yds)}</td>
                    <td className="num" data-label="Wastage">
                      {fmtPct(o.projected_wastage_pct)}
                      {o.over_wastage_cap && <div className="small" style={{ color: 'var(--red)', fontWeight: 700 }}>over {o.wastage_cap}% cap</div>}
                    </td>
                    <td data-label="Status">
                      <StatusBadge status={o.status} />
                      {o.status === 'REJECTED' && o.rejection_note && <div className="small" style={{ marginTop: 4, maxWidth: 240 }}>"{o.rejection_note}"</div>}
                    </td>
                    <td className="small" data-label="Created">{fmtTime(o.created_at)}</td>
                    <td data-label="Actions" className="actions-cell">
                      {o.status === 'CUTTING_IN_PROGRESS' && (
                        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                          <button className="secondary" onClick={() => { setNotice(''); setEditing(o); }}>Edit</button>
                          <button onClick={() => submitDraft(o)}>Submit to QC</button>
                        </div>
                      )}
                      {o.status === 'REJECTED' && <button onClick={() => setResubmit(o)}>Re-cut &amp; resubmit</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && (
        <NewOrderModal recipes={recipes} onClose={() => setShowNew(false)}
          onDone={(msg) => { setShowNew(false); setNotice(msg); refresh(); }} />
      )}
      {editing && (
        <NewOrderModal recipes={recipes} order={editing} onClose={() => setEditing(null)}
          onDone={(msg) => { setEditing(null); setNotice(msg); refresh(); }} />
      )}
      {resubmit && (
        <ResubmitModal order={resubmit} onClose={() => setResubmit(null)}
          onDone={(msg) => { setResubmit(null); setNotice(msg); refresh(); }} />
      )}
      {detail && <DetailModal order={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function NewOrderModal({ recipes, order, onClose, onDone }) {
  const editing = !!order;
  const [recipeId, setRecipeId] = useState(order ? String(order.recipe_id) : '');
  const [qty, setQty] = useState(order ? String(order.target_qty) : '');
  const [roll, setRoll] = useState(order ? order.fabric_roll_id : '');
  const [yards, setYards] = useState(order ? String(order.actual_fabric_yds) : '');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const recipe = recipes.find((r) => String(r.id) === String(recipeId));
  const qtyParsed = parseWhole(qty);
  const yardsParsed = parseYards(yards);

  const validate = () => {
    const e = {};
    if (!recipe) e.recipe_id = 'Choose a recipe';
    if (qtyParsed.empty) e.target_qty = 'Enter the batch quantity';
    else if (qtyParsed.error) e.target_qty = qtyParsed.error;
    else if (qtyParsed.value < 1) e.target_qty = 'Must be at least 1';
    else if (qtyParsed.value > 100000) e.target_qty = 'Maximum batch size is 100,000';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(roll.trim())) e.fabric_roll_id = 'Use 3-40 letters, digits, "-" or "_" (e.g. FAB-ROLL-882)';
    if (yardsParsed.empty) e.actual_fabric_yds = 'Enter the fabric used in yards';
    else if (yardsParsed.error) e.actual_fabric_yds = yardsParsed.error;
    return e;
  };

  const send = async (submit) => {
    const e = validate();
    setErrors(e);
    setFormError('');
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const payload = { recipe_id: recipe.id, target_qty: qtyParsed.value, fabric_roll_id: roll.trim(), actual_fabric_yds: yardsParsed.value };
      if (editing) {
        await api(`/orders/${order.id}`, { method: 'PUT', body: payload });
        if (submit) await api(`/orders/${order.id}/submit`, { method: 'POST', body: {} });
        onDone(submit ? `${order.order_no} updated and sent to the verification terminal.` : `${order.order_no} draft updated.`);
        return;
      }
      const res = await api('/orders', { method: 'POST', body: { ...payload, submit } });
      onDone(submit ? `${res.order.order_no} created and sent to the verification terminal.` : `${res.order.order_no} saved as a draft.`);
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
    } finally { setBusy(false); }
  };

  const expectedFabric = recipe && qtyParsed.value ? recipe.std_fabric_yards * qtyParsed.value : null;

  return (
    <Modal title={editing ? `Edit draft ${order.order_no}` : 'New cutting order'} onClose={onClose}>
      {formError && <Alert>{formError}</Alert>}
      <Field id="recipe" label="Recipe" error={errors.recipe_id}>
        <select id="recipe" disabled={editing} value={recipeId} onChange={(e) => setRecipeId(e.target.value)} className={errors.recipe_id ? 'invalid' : ''}>
          <option value="">Select a recipe...</option>
          {recipes.map((r) => <option key={r.id} value={r.id}>{r.recipe_code} - {r.name}</option>)}
        </select>
      </Field>
      <div className="grid2">
        <Field id="qty" label="Target batch quantity" error={errors.target_qty} hint="Garments, whole number">
          <input id="qty" inputMode="numeric" autoComplete="off" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="e.g. 50" className={errors.target_qty ? 'invalid' : ''} />
        </Field>
        <Field id="roll" label="Fabric roll ID" error={errors.fabric_roll_id}>
          <input id="roll" autoComplete="off" value={roll} onChange={(e) => setRoll(e.target.value)} placeholder="e.g. FAB-ROLL-882" className={errors.fabric_roll_id ? 'invalid' : ''} />
        </Field>
      </div>
      <Field id="yards" label="Actual fabric used (yards)" error={errors.actual_fabric_yds}>
        <input id="yards" inputMode="decimal" autoComplete="off" value={yards} onChange={(e) => setYards(e.target.value)} placeholder="e.g. 92.5" className={errors.actual_fabric_yds ? 'invalid' : ''} />
      </Field>

      {recipe && (
        <div className="card" style={{ background: '#faf8f3' }}>
          <h3>Expected output</h3>
          <div className="small muted" style={{ marginBottom: 8 }}>
            Std {recipe.std_fabric_yards} yd/piece, wastage cap {recipe.wastage_cap}%
            {expectedFabric !== null && <> - expected fabric <b>{fmtYds(expectedFabric)}</b></>}
          </div>
          <table>
            <thead><tr><th>Component</th><th className="num">Per garment</th><th className="num">Expected cut</th></tr></thead>
            <tbody>
              {recipe.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.component_name}</td>
                  <td className="num">{c.pieces_per_garment}</td>
                  <td className="num"><b>{qtyParsed.value ? c.pieces_per_garment * qtyParsed.value : '-'}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="secondary" disabled={busy} onClick={() => send(false)}>{editing ? 'Save changes' : 'Save as draft'}</button>
        <button disabled={busy} onClick={() => send(true)}>{busy ? 'Saving...' : editing ? 'Save & submit to QC' : 'Create & submit to QC'}</button>
      </div>
    </Modal>
  );
}

function ResubmitModal({ order, onClose, onDone }) {
  const [roll, setRoll] = useState(order.fabric_roll_id);
  const [yards, setYards] = useState(String(order.actual_fabric_yds));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    const y = parseYards(yards);
    const e = {};
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(roll.trim())) e.fabric_roll_id = 'Use 3-40 letters, digits, "-" or "_"';
    if (y.empty) e.actual_fabric_yds = 'Enter the fabric used in yards';
    else if (y.error) e.actual_fabric_yds = y.error;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api(`/orders/${order.id}/submit`, { method: 'POST', body: { fabric_roll_id: roll.trim(), actual_fabric_yds: y.value } });
      onDone(`${order.order_no} resubmitted. The verifier will need to recount every component.`);
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Resubmit ${order.order_no}`} onClose={onClose}>
      <Alert kind="warn">Verifier's reason: "{order.rejection_note}"</Alert>
      {formError && <Alert>{formError}</Alert>}
      <p className="muted">Update the fabric details after re-cutting. All previous counts are cleared.</p>
      <Field id="r-roll" label="Fabric roll ID" error={errors.fabric_roll_id}>
        <input id="r-roll" value={roll} onChange={(e) => setRoll(e.target.value)} className={errors.fabric_roll_id ? 'invalid' : ''} />
      </Field>
      <Field id="r-yards" label="Actual fabric used (yards)" error={errors.actual_fabric_yds}>
        <input id="r-yards" inputMode="decimal" value={yards} onChange={(e) => setYards(e.target.value)} className={errors.actual_fabric_yds ? 'invalid' : ''} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button disabled={busy} onClick={go}>{busy ? 'Submitting...' : 'Resubmit to QC'}</button>
      </div>
    </Modal>
  );
}

function DetailModal({ order, onClose }) {
  return (
    <Modal title={order.order_no} onClose={onClose}>
      <dl className="kv">
        <dt>Recipe</dt><dd>{order.recipe_code} - {order.recipe_name}</dd>
        <dt>Status</dt><dd><StatusBadge status={order.status} /></dd>
        <dt>Batch</dt><dd>{order.target_qty} garments from {order.fabric_roll_id}</dd>
        <dt>Fabric</dt><dd>{fmtYds(order.actual_fabric_yds)} used vs {fmtYds(order.expected_fabric_yds)} expected ({fmtPct(order.projected_wastage_pct)})</dd>
      </dl>
      <table>
        <thead><tr><th>Component</th><th className="num">Expected</th><th className="num">Counted</th></tr></thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id}><td>{i.component_name}</td><td className="num">{i.expected_qty}</td><td className="num">{i.actual_qty ?? '-'}</td></tr>
          ))}
        </tbody>
      </table>
      {order.logs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3>QC history</h3>
          {order.logs.map((l) => (
            <div key={l.id} className="small" style={{ marginBottom: 6 }}>
              <b>{l.decision}</b> by {l.verifier_name} on {fmtTime(l.timestamp)}{l.rejection_note ? ` - "${l.rejection_note}"` : ''}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
