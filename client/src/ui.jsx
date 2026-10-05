import React, { useEffect } from 'react';

const STATUS_TEXT = {
  CUTTING_IN_PROGRESS: 'Cutting in progress',
  PENDING_VERIFICATION: 'Pending verification',
  REJECTED: 'Rejected',
  VERIFIED: 'Verified',
  SEWING_STARTED: 'Sewing started',
};

export const StatusBadge = ({ status }) => (
  <span className={`badge b-${status}`}>{STATUS_TEXT[status] || status}</span>
);

const LIGHT_TEXT = { GREEN: 'Match', YELLOW: 'Excess', RED: 'Shortage', NONE: 'Not counted' };

export const Light = ({ status }) => {
  const s = status || 'NONE';
  return (
    <span className={`light ${s}`}>
      <i aria-hidden="true" />
      {LIGHT_TEXT[s]}
    </span>
  );
};

export function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="field-error" role="alert" id={`${id}-err`}>{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="secondary" onClick={onClose} aria-label="Close dialog">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Alert = ({ kind = 'error', children }) => (
  <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>
);

export const fmtYds = (n) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} yd`;
export const fmtPct = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
