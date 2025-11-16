// AdminPasswordDialog: modal form to update the admin password with basic validation.
import React, { useEffect, useRef, useState } from 'react';
import './AdminDashboard.css';

interface AdminPasswordDialogProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void> | void;
  serverError?: string;
}

const MIN_LENGTH = 8;

const EyeIcon: React.FC<{ concealed: boolean }> = ({ concealed }) => (
  <svg
    className="password-eye-icon"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M1 12c1.73-4.89 6.08-8 11-8s9.27 3.11 11 8c-1.73 4.89-6.08 8-11 8S2.73 16.89 1 12Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle
      cx="12"
      cy="12"
      r="3.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    {!concealed && (
      <line
        x1="4"
        y1="4"
        x2="20"
        y2="20"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    )}
  </svg>
);

const AdminPasswordDialog: React.FC<AdminPasswordDialogProps> = ({ open, busy, onClose, onSubmit, serverError }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const currentRef = useRef<HTMLInputElement | null>(null);
  const newRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);

  const toggleVisibility = (
    setter: React.Dispatch<React.SetStateAction<boolean>>,
    ref: React.RefObject<HTMLInputElement | null>
  ) => {
    const el = ref.current;
    const length = el ? el.value.length : 0;
    const start = el && el.selectionStart !== null ? el.selectionStart : length;
    const end = el && el.selectionEnd !== null ? el.selectionEnd : length;
    setter(prev => !prev);
    requestAnimationFrame(() => {
      const input = ref.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(start, end);
      } catch (err) {
        // Ignore selection errors (e.g., unsupported input types)
      }
    });
  };

  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError('');
      setShowCurrent(false);
      setShowNew(false);
      setShowConfirm(false);
    }
  }, [open]);

  useEffect(() => {
    if (serverError !== undefined) {
      setError(serverError);
    }
  }, [serverError]);

  if (!open) return null;

  const confirmMismatch = newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword;

  const validate = () => {
    if (!currentPassword) {
      setError('Enter your current password.');
      return false;
    }
    if (!newPassword) {
      setError('Enter a new password.');
      return false;
    }
    if (newPassword.length < MIN_LENGTH) {
      setError(`New password must be at least ${MIN_LENGTH} characters.`);
      return false;
    }
    const hasLetter = /[A-Za-z]/.test(newPassword);
    const hasNumber = /\d/.test(newPassword);
    if (!(hasLetter && hasNumber)) {
      setError('Include both letters and numbers for a stronger password.');
      return false;
    }
    if (confirmMismatch) {
      setError('');
      return false;
    }
    if (newPassword === currentPassword) {
      setError('New password must differ from the current password.');
      return false;
    }
    setError('');
    return true;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    await onSubmit(currentPassword, newPassword);
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-password-title">
      <div className="modal-dialog password-dialog">
        <h4 id="admin-password-title" className="modal-title">Change Admin Password</h4>
        <div className="password-fields">
          <label className="password-label" htmlFor="admin-current-password">Current Password</label>
          <div className="password-input-wrap">
            <input
              id="admin-current-password"
              type={showCurrent ? 'text' : 'password'}
              className="password-input"
              value={currentPassword}
              onChange={(e) => { setCurrentPassword(e.target.value); if (error) setError(''); }}
              disabled={busy}
              autoComplete="current-password"
              ref={currentRef}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => toggleVisibility(setShowCurrent, currentRef)}
              onMouseDown={(e) => e.preventDefault()}
              disabled={busy}
              aria-label={showCurrent ? 'Hide current password' : 'Show current password'}
            >
              <EyeIcon concealed={!showCurrent} />
            </button>
          </div>

          <label className="password-label" htmlFor="admin-new-password">New Password</label>
          <div className="password-input-wrap">
            <input
              id="admin-new-password"
              type={showNew ? 'text' : 'password'}
              className="password-input"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); if (error) setError(''); }}
              disabled={busy}
              autoComplete="new-password"
              ref={newRef}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => toggleVisibility(setShowNew, newRef)}
              onMouseDown={(e) => e.preventDefault()}
              disabled={busy}
              aria-label={showNew ? 'Hide new password' : 'Show new password'}
            >
              <EyeIcon concealed={!showNew} />
            </button>
          </div>

          <label className="password-label" htmlFor="admin-confirm-password">Confirm New Password</label>
          <div className="password-input-wrap">
            <input
              id="admin-confirm-password"
              type={showConfirm ? 'text' : 'password'}
              className={`password-input ${confirmMismatch ? 'invalid' : ''}`}
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); if (error) setError(''); }}
              disabled={busy}
              autoComplete="new-password"
              ref={confirmRef}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => toggleVisibility(setShowConfirm, confirmRef)}
              onMouseDown={(e) => e.preventDefault()}
              disabled={busy}
              aria-label={showConfirm ? 'Hide confirmation password' : 'Show confirmation password'}
            >
              <EyeIcon concealed={!showConfirm} />
            </button>
          </div>
          {confirmMismatch && <div className="password-inline-error" role="alert">New password and confirmation must match.</div>}
          <div className="password-hint">Use at least {MIN_LENGTH} characters with a mix of letters and numbers.</div>
          {error && <div className="password-error" role="alert">{error}</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={busy}>{busy ? 'Saving...' : 'Update Password'}</button>
        </div>
      </div>
    </div>
  );
};

export default AdminPasswordDialog;
