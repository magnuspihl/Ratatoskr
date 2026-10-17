import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import type { Preferences } from '../../../shared/types';
import { api } from '../api';

export function SettingsDialog({ prefs, onClose }: { prefs: Preferences; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(prefs);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: Preferences) => {
    setV(next);
    try {
      await api.savePreferences(next);
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(460px, 100%)' }}>
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="label">Appearance</label>
            <div className="segmented">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button key={t} className={v.theme === t ? 'on' : ''} onClick={() => void save({ ...v, theme: t })} style={{ padding: '6px 14px' }}>
                  {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Messages per page</label>
            <select className="select" value={v.pageSize} onChange={(e) => void save({ ...v, pageSize: Number(e.target.value) })}>
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={v.markReadOnOpen} onChange={(e) => void save({ ...v, markReadOnOpen: e.target.checked })} />
            Mark messages as read when opened
          </label>
          {error && <div className="error-text">{error}</div>}
        </div>
      </div>
    </div>
  );
}
