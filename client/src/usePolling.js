import { useEffect, useRef, useState } from 'react';

// Calls load() immediately, then every `ms` while the tab is visible. Returns a manual refresh and last-updated time.
export function usePolling(load, ms = 8000) {
  const [updatedAt, setUpdatedAt] = useState(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = async () => {
    await loadRef.current();
    setUpdatedAt(new Date());
  };

  useEffect(() => {
    run();
    const id = setInterval(() => { if (document.visibilityState === 'visible') run(); }, ms);
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [ms]);

  return { refresh: run, updatedAt };
}

export const timeLabel = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
