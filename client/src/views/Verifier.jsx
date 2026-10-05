import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtTime, parseWhole } from '../api.js';
import { Alert, Field, Light, StatusBadge, fmtYds, fmtPct } from '../ui.jsx';
import { usePolling, timeLabel } from '../usePolling.js';

// UI-only preview of the traffic light. The server recomputes this and is the real authority.
const light = (actual, expected) => (actual === null ? null : actual === expected ? 'GREEN' : actual > expected ? 'YELLOW' : 'RED');

export default function Verifier() {
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const { orders: list } = await api('/orders');
      setOrders(list);
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);

  const { refresh, updatedAt } = usePolling(load, 8000);

  const pending = orders.filter((o) => o.status === 'PENDING_VERIFICATION');
  const history = orders.filter((o) => o.status !== 'PENDING_VERIFICATION');

  useEffect(() => {
    if (selectedId === null && pending.length) setSelectedId(pending[0].id);
  }, [pending, selectedId]);

  const done = (msg) => { setNotice(msg); refresh(); };

  return (
    <>
      <div className="row between">
        <div>
          <h1>Verification terminal</h1>
          <p className="muted">Count the physical pieces of every component. A single shortage blocks approval.</p>
        </div>
        <div className="row small muted">
          {updatedAt && <span>Updated {timeLabel(updatedAt)}</span>}
          <button className="secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div className="split">
        <aside>
          <div className="card">
            <h3>Waiting at QC ({pending.length})</h3>
            {loading ? <div className="empty">Loading...</div> : pending.length === 0 ? (
              <div className="empty">Nothing waiting. Bundles show up here once the supervisor submits them.</div>
            ) : (
              <ul className="order-list">
                {pending.map((o) => <OrderListItem key={o.id} o={o} selected={o.id === selectedId} onClick={() => { setSelectedId(o.id); setNotice(''); }} />)}
              </ul>
            )}
          </div>
          <div className="card">
            <h3>Recent decisions</h3>
            {history.length === 0 ? <div className="small muted">No decisions yet.</div> : (
              <ul className="order-list">
                {history.slice(0, 8).map((o) => <OrderListItem key={o.id} o={o} selected={o.id === selectedId} onClick={() => { setSelectedId(o.id); setNotice(''); }} />)}
              </ul>
            )}
          </div>
        </aside>

        <section>
          {selectedId ? <Terminal key={selectedId} orderId={selectedId} onDecided={done} /> : (
            <div className="card empty">Select a batch to start counting.</div>
          )}
        </section>
      </div>
    </>
  );
}

function OrderListItem({ o, selected, onClick }) {
  return (
    <li>
      <button className={selected ? 'sel' : ''} onClick={onClick}>
        <div className="t"><span className="mono">{o.order_no}</span><StatusBadge status={o.status} /></div>
        <div className="small muted">{o.recipe_name} - {o.target_qty} garments - {o.fabric_roll_id}</div>
      </button>
    </li>
  );
}

function Terminal({ orderId, onDecided }) {
  const [order, setOrder] = useState(null);
  const [inputs, setInputs] = useState({});
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');

  const hydrate = (o) => {
    setOrder(o);
    setInputs(Object.fromEntries(o.items.map((i) => [i.component_id, i.actual_qty === null ? '' : String(i.actual_qty)])));
  };

  useEffect(() => {
    api(`/orders/${orderId}`).then((d) => hydrate(d.order)).catch((e) => setError(e.message));
  }, [orderId]);

  const rows = useMemo(() => {
    if (!order) return [];
    return order.items.map((i) => {
      const p = parseWhole(inputs[i.component_id] ?? '');
      const actual = p.value !== undefined ? p.value : null;
      return { ...i, parsed: p, actual, light: light(actual, i.expected_qty) };
    });
  }, [order, inputs]);

  if (!order) return <div className="card empty">{error || 'Loading batch...'}</div>;

  const editable = order.status === 'PENDING_VERIFICATION';
  const hasInvalid = rows.some((r) => r.parsed.error);
  const allCounted = rows.every((r) => r.actual !== null);
  const anyRed = rows.some((r) => r.light === 'RED');
  const canApprove = editable && allCounted && !anyRed && !hasInvalid;

  const persistCounts = async () => {
    const e = {};
    rows.forEach((r) => { if (r.parsed.error) e[r.component_id] = r.parsed.error; });
    setErrors(e);
    if (Object.keys(e).length) throw new Error('Fix the highlighted counts first');
    const counts = rows.filter((r) => r.actual !== null).map((r) => ({ component_id: r.component_id, actual_qty: r.actual }));
    if (!counts.length) throw new Error('Enter at least one count');
    const d = await api(`/orders/${order.id}/counts`, { method: 'PUT', body: { counts } });
    setOrder(d.order);
  };

  const saveOnly = async () => {
    setBusy(true); setError(''); setSaved('');
    try { await persistCounts(); setSaved('Counts saved.'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const approve = async () => {
    setBusy(true); setError('');
    try {
      await persistCounts();
      const d = await api(`/orders/${order.id}/approve`, { method: 'POST', body: {} });
      onDecided(`${d.order.order_no} approved and released to the sewing queue.`);
      hydrate(d.order);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const reject = async () => {
    const t = note.trim();
    if (t.length < 5) { setNoteError('A reason is mandatory (at least 5 characters)'); return; }
    setNoteError(''); setBusy(true); setError('');
    try {
      // Save whatever has been counted so the supervisor sees the evidence, then reject.
      if (rows.some((r) => r.actual !== null) && !hasInvalid) await persistCounts();
      const d = await api(`/orders/${order.id}/reject`, { method: 'POST', body: { note: t } });
      onDecided(`${d.order.order_no} rejected and returned to the cutting supervisor.`);
      hydrate(d.order);
      setRejecting(false);
    } catch (e) { setError(e.message); setNoteError(e.fields?.note || ''); } finally { setBusy(false); }
  };

  const decided = order.logs[0];

  return (
    <div className="card">
      <div className="row between">
        <div>
          <h2 className="mono" style={{ marginBottom: 2 }}>{order.order_no}</h2>
          <div className="muted">{order.recipe_name} ({order.recipe_code}) - {order.target_qty} garments - roll {order.fabric_roll_id}</div>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Fabric used</dt><dd>{fmtYds(order.actual_fabric_yds)} vs {fmtYds(order.expected_fabric_yds)} expected</dd>
        <dt>Wastage</dt>
        <dd>{fmtPct(order.projected_wastage_pct)} <span className="muted small">(cap {order.wastage_cap}%)</span>
          {order.over_wastage_cap && <span style={{ color: 'var(--red)', marginLeft: 8 }}>over cap - note it in your decision</span>}</dd>
      </dl>

      {error && <Alert>{error}</Alert>}
      {saved && <Alert kind="ok">{saved}</Alert>}
      {!editable && decided && (
        <div className="audit">
          <b>{decided.decision === 'APPROVED' ? 'Approved' : 'Rejected'}</b> by {decided.verifier_name} on {fmtTime(decided.timestamp)}
          {decided.rejection_note && <div>Reason: "{decided.rejection_note}"</div>}
          <div className="small muted">This record is sealed and cannot be edited.</div>
        </div>
      )}

      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr><th>Component</th><th className="num">Per garment</th><th className="num">Expected</th><th style={{ width: 150 }}>Actual count</th><th className="num">Variance</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.component_id} className={r.light ? `row-${r.light}` : ''}>
                <td data-label="Component"><label htmlFor={`c-${r.component_id}`}>{r.component_name}</label></td>
                <td className="num" data-label="Per garment">{r.pieces_per_garment}</td>
                <td className="num" data-label="Expected"><b>{r.expected_qty}</b></td>
                <td data-label="Actual count" className="count-cell">
                  <input id={`c-${r.component_id}`} inputMode="numeric" autoComplete="off" disabled={!editable || busy}
                    value={inputs[r.component_id] ?? ''} className={r.parsed.error || errors[r.component_id] ? 'invalid' : ''}
                    onChange={(e) => { setInputs({ ...inputs, [r.component_id]: e.target.value }); setSaved(''); }}
                    aria-describedby={r.parsed.error ? `c-${r.component_id}-err` : undefined} />
                  {r.parsed.error && <div className="field-error" id={`c-${r.component_id}-err`} role="alert">{r.parsed.error}</div>}
                </td>
                <td className="num" data-label="Variance">{r.actual === null ? '-' : r.actual - r.expected_qty > 0 ? `+${r.actual - r.expected_qty}` : r.actual - r.expected_qty}</td>
                <td data-label="Status"><Light status={r.light} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <>
          <div style={{ marginTop: 14 }}>
            {anyRed && <Alert>Shortage detected. Approval is blocked until every component matches or exceeds the expected count. You may only reject this batch.</Alert>}
            {!anyRed && !allCounted && <Alert kind="info">Count every component to unlock approval.</Alert>}
            {canApprove && <Alert kind="ok">All components counted with no shortage. This batch can be approved.</Alert>}
          </div>

          {rejecting ? (
            <div className="card" style={{ background: '#fff7f7', borderColor: '#e2a3a3' }}>
              <Field id="note" label="Rejection reason (required)" error={noteError}>
                <textarea id="note" rows={3} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
                  className={noteError ? 'invalid' : ''} placeholder="e.g. Left sleeves short by 6 pieces, fabric flaw on roll end" />
              </Field>
              <div className="row">
                <button className="bad" disabled={busy} onClick={reject}>{busy ? 'Rejecting...' : 'Confirm rejection'}</button>
                <button className="secondary" disabled={busy} onClick={() => { setRejecting(false); setNoteError(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="secondary" disabled={busy} onClick={saveOnly}>Save counts</button>
              <button className="bad" disabled={busy} onClick={() => setRejecting(true)}>Reject batch</button>
              <button className="good" disabled={!canApprove || busy} onClick={approve}
                title={canApprove ? 'Approve and release to sewing' : 'Approval is locked until all components are counted with no shortage'}>
                Approve batch
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
