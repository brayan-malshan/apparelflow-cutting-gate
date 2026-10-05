import React, { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from '../api.js';
import { Alert, Light, StatusBadge, fmtYds, fmtPct } from '../ui.jsx';
import { usePolling, timeLabel } from '../usePolling.js';

export default function Sewing() {
  const [tab, setTab] = useState('queue');
  const [queue, setQueue] = useState([]);
  const [started, setStarted] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api('/sewing/queue'), api('/sewing/in-progress')]);
      setQueue(a.orders);
      setStarted(b.orders);
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);

  const { refresh, updatedAt } = usePolling(load, 8000);

  const start = async (o) => {
    setBusyId(o.id); setError('');
    try {
      await api(`/sewing/${o.id}/start`, { method: 'POST' });
      setNotice(`${o.order_no} is now on the assembly line.`);
      await refresh();
    } catch (e) { setError(e.message); await refresh(); } finally { setBusyId(null); }
  };

  const list = tab === 'queue' ? queue : started;

  return (
    <>
      <div className="row between">
        <div>
          <h1>Sewing queue</h1>
          <p className="muted">Only batches signed off by the cutting verifier appear here.</p>
        </div>
        <div className="row small muted">
          {updatedAt && <span>Updated {timeLabel(updatedAt)}</span>}
          <button className="secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'queue' ? '' : 'secondary'} onClick={() => setTab('queue')}>Ready for sewing ({queue.length})</button>
        <button className={tab === 'started' ? '' : 'secondary'} onClick={() => setTab('started')}>On the line ({started.length})</button>
      </div>

      {loading ? <div className="card empty">Loading...</div> : list.length === 0 ? (
        <div className="card empty">
          {tab === 'queue' ? 'No verified batches waiting. When QC approves a batch it will appear here.' : 'Nothing is on the assembly line yet.'}
        </div>
      ) : list.map((o) => (
        <div className="card sewing-card" key={o.id}>
          <div className="row between">
            <div>
              <h2 className="mono" style={{ marginBottom: 2 }}>{o.order_no}</h2>
              <div className="muted">{o.recipe_name} ({o.recipe_code}) - {o.target_qty} garments - roll {o.fabric_roll_id}</div>
            </div>
            <StatusBadge status={o.status} />
          </div>

          {o.approval && (
            <div className="audit" style={{ marginTop: 12 }}>
              <b>Verified by {o.approval.verifier_name}</b> on {fmtTime(o.approval.timestamp)}
              <div className="small">
                Fabric wastage {fmtPct(o.approval.wastage_pct)} ({fmtYds(o.actual_fabric_yds)} used vs {fmtYds(o.expected_fabric_yds)} expected, cap {o.wastage_cap}%)
                {o.approval.wastage_pct > o.wastage_cap && <b style={{ color: 'var(--red)' }}> - over cap</b>}
              </div>
            </div>
          )}

          <div className="table-wrap">
            <table className="stack">
              <thead><tr><th>Component</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Variance</th><th>QC result</th></tr></thead>
              <tbody>
                {(o.approval?.variance || []).map((v) => (
                  <tr key={v.component_id}>
                    <td data-label="Component">{v.component_name}</td>
                    <td className="num" data-label="Expected">{v.expected_qty}</td>
                    <td className="num" data-label="Counted">{v.actual_qty}</td>
                    <td className="num" data-label="Variance">{v.variance > 0 ? `+${v.variance}` : v.variance}</td>
                    <td data-label="QC result"><Light status={v.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {o.status === 'VERIFIED' && (
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="good" disabled={busyId === o.id} onClick={() => start(o)}>
                {busyId === o.id ? 'Starting...' : 'Start sewing assembly'}
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
