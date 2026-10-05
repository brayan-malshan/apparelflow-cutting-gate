import React, { useCallback, useEffect, useState } from 'react';
import { api, setToken, getToken, DEMO, ROLE_LABEL } from './api.js';
import Login from './views/Login.jsx';
import Supervisor from './views/Supervisor.jsx';
import Verifier from './views/Verifier.jsx';
import Sewing from './views/Sewing.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [switching, setSwitching] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => { setUser(null); setExpired(true); };
    window.addEventListener('af:unauthorized', onUnauthorized);
    return () => window.removeEventListener('af:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setToken(null))
      .finally(() => setBooting(false));
  }, []);

  const signIn = useCallback(async (email, password) => {
    const d = await api('/auth/login', { method: 'POST', body: { email, password } });
    setToken(d.token);
    setExpired(false);
    setUser(d.user);
  }, []);

  const signOut = () => {
    setToken(null);
    setUser(null);
  };

  const switchTo = async (persona) => {
    setSwitching(true);
    try {
      await signIn(persona.email, persona.password);
    } finally {
      setSwitching(false);
    }
  };

  if (booting) return <div className="page muted">Loading...</div>;
  if (!user) return <Login onLogin={signIn} expired={expired} />;

  const View = { cutting_supervisor: Supervisor, cutting_verifier: Verifier, sewing_supervisor: Sewing }[user.role];

  return (
    <>
      <header className="topbar">
        <div className="brand">Apparel<span>Flow</span> <span style={{ color: '#fff', fontWeight: 400, opacity: 0.8 }}>/ Cutting Gate</span></div>
        <div className="spacer" />
        <div className="switcher" aria-label="Role switcher">
          <span className="label">Demo role</span>
          {DEMO.map((p) => (
            <button
              key={p.role}
              className={`chip ${user.role === p.role ? 'active' : ''}`}
              disabled={switching || user.role === p.role}
              onClick={() => switchTo(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="who">
          <b>{user.full_name}</b>
          <span>{ROLE_LABEL[user.role]}</span>
        </div>
        <button className="chip" onClick={signOut}>Sign out</button>
      </header>
      <main className="page">
        <View user={user} key={user.id} />
      </main>
    </>
  );
}
