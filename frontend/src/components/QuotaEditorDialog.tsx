// QuotaEditorDialog: modal to adjust per-user storage quota with validation & presets.
import React, { useEffect, useState } from 'react';
import './AdminDashboard.css';

interface QuotaEditorDialogProps {
  open: boolean;
  username: string | null;
  usageBytes: number;
  quotaBytes: number;
  busy: boolean;
  onClose: () => void;
  onSave: (newQuotaMB: number) => Promise<void> | void;
}

const MIN_MB = 50;

const QuotaEditorDialog: React.FC<QuotaEditorDialogProps> = ({ open, username, usageBytes, quotaBytes, busy, onClose, onSave }) => {
  const usageMBExact = usageBytes / 1024 / 1024;
  const usageMB = Math.ceil(usageMBExact);
  const currentQuotaMB = Math.round(quotaBytes / 1024 / 1024);
  const effectiveMin = Math.max(MIN_MB, usageMB); // don't let admin set lower than current usage
  const initial = Math.max(currentQuotaMB, effectiveMin);
  const [value, setValue] = useState<number>(initial);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (open) {
      const init = Math.max(Math.round(quotaBytes / 1024 / 1024), effectiveMin);
      setValue(init);
      setError('');
    }
  }, [open, quotaBytes, effectiveMin]);

  if (!open || !username) return null;

  // Percent based on CURRENT quota, not the pending edited value (shows live situation)
  const percent = quotaBytes > 0 ? Math.min(100, (usageBytes / quotaBytes) * 100) : 0;
  const levelClass = percent >= 98 ? 'level-critical' : percent >= 90 ? 'level-high' : percent >= 75 ? 'level-warn' : 'level-ok';
  const bucket = Math.round(percent); // 0-100 integer bucket for CSS width class

  const MAX_MB = 10240; // 10GB hard cap
  const validate = (v: number) => {
    if (isNaN(v)) { setError('Enter a number'); return false; }
    if (v < effectiveMin) { setError(`Minimum ${effectiveMin} MB (current usage)`); return false; }
    if (v > MAX_MB) { setError(`Maximum ${MAX_MB} MB (10GB)`); return false; }
    setError('');
    return true;
  };

  const commit = async () => {
    if (!validate(value)) return;
    await onSave(value);
  };

  // Preset quota sizes (MB) including new larger options 5GB and 10GB
  const presets = [50, 100, 250, 500, 1024, 5120, 10240];

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="quota-edit-title">
      <div className="modal-dialog quota-dialog">
        <h4 id="quota-edit-title" className="modal-title">Storage Quota – {username}</h4>
        <div className="quota-usage-block">
          <div className="quota-bar" aria-label={`Usage ${percent.toFixed(1)}%`}>
            <div className={`quota-bar-fill ${levelClass} pct-${bucket}`} />
          </div>
          <div className="quota-usage-stats">
            <span>{usageMBExact.toFixed(2)} MB used ({percent.toFixed(1)}%)</span>
            <span>{(quotaBytes/1024/1024).toFixed(0)} MB quota</span>
          </div>
        </div>
        <label htmlFor="quota-number" className="quota-label">New Quota (MB)</label>
        <input
          id="quota-number"
          type="number"
          className="quota-input quota-input-main"
          min={effectiveMin}
          max={10240}
          value={value}
          disabled={busy}
          onChange={e => {
            let v = parseInt(e.target.value || '0',10);
            if (v > 10240) { v = 10240; e.target.value = String(v); }
            setValue(v);
            validate(v);
          }}
        />
        <div className="quota-presets" role="group" aria-label="Preset quotas">
          {presets.map(p => (
            <button key={p} type="button" disabled={busy || p < effectiveMin} className="preset-btn" onClick={() => { setValue(p); validate(p); }}>{p}MB</button>
          ))}
        </div>
        {error && <div className="quota-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !!error} onClick={commit}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
        <div className="quota-footnote">Cannot set below current usage ({usageMB} MB) or below 50MB. Enforcement applies to new writes.</div>
      </div>
    </div>
  );
};

export default QuotaEditorDialog;
