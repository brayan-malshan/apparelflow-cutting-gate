import React, { useState } from 'react';
import { DEMO } from '../api.js';
import { Alert, Field } from '../ui.jsx';

export default function Login({ onLogin, expired }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const attempt = async (e, p) => {
    setFormError('');
    setBusy(true);
    try {
      await onLogin(e, p);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (ev) => {
    ev.preventDefault();
    const errs = {};
    if (!email.trim()) errs.email = 'Enter your email';
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = 'That does not look like an email address';
    if (!password) errs.password = 'Enter your password';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    attempt(email, password);
  };

  return (
    <div className="login-wrap">
      <section className="login-hero">
        <h1>Nothing reaches the sewing line unchecked.</h1>
        <p>
          ApparelFlow's Cutting Gate counts every component of every bundle before a batch is released to assembly.
          One shortage and the batch goes back to the cutting table.
        </p>
        <div className="steps">
          <div className="step"><b>1. Cut</b><br />Supervisor opens an order from a production recipe.</div>
          <div className="step"><b>2. Count</b><br />Verifier counts parts. Traffic lights decide if approval is allowed.</div>
          <div className="step"><b>3. Sew</b><br />Only signed-off batches show up on the sewing floor.</div>
        </div>
      </section>

      <section className="login-panel">
        <h2>Sign in</h2>
        <p className="muted">Use your factory account, or jump in with one of the demo personas below.</p>
        {expired && <Alert kind="warn">Your session expired. Please sign in again.</Alert>}
        {formError && <Alert>{formError}</Alert>}
        <form onSubmit={submit} noValidate>
          <Field id="email" label="Email" error={errors.email}>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
              className={errors.email ? 'invalid' : ''} placeholder="you@apparelflow.demo" />
          </Field>
          <Field id="password" label="Password" error={errors.password}>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
              className={errors.password ? 'invalid' : ''} />
          </Field>
          <button type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
        </form>

        <div className="demo">
          <b>Demo credential panel</b>
          <div className="small muted">Click a persona to sign in instantly, or copy the credentials.</div>
          {DEMO.map((d) => (
            <button key={d.role} className="persona" disabled={busy} onClick={() => attempt(d.email, d.password)}>
              <b>{d.label}</b>
              <span className="small muted">{d.blurb}</span>
              <span className="small mono" style={{ display: 'block', marginTop: 4 }}>{d.email} / {d.password}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
