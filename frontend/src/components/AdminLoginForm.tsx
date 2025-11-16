// AdminLoginForm: password-based admin auth form.
import React, { useRef, useState } from 'react';
import './LoginForm.css';

interface AdminLoginFormProps {
  onLogin: (password: string) => void;
  onBack: () => void;
  error?: string;
  isLoading?: boolean;
}

const AdminLoginForm: React.FC<AdminLoginFormProps> = ({ onLogin, onBack, error = '', isLoading = false }) => {
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

  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const toggleVisibility = () => {
    const el = passwordRef.current;
    const length = el ? el.value.length : 0;
    const start = el && el.selectionStart !== null ? el.selectionStart : length;
    const end = el && el.selectionEnd !== null ? el.selectionEnd : length;
    setShowPassword(prev => !prev);
    requestAnimationFrame(() => {
      const input = passwordRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(start, end);
      } catch {
        /* ignore selection errors */
      }
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!password.trim()) return;
    onLogin(password.trim());
  };

  const disabled = isLoading || !password.trim();

  return (
    <div className="login-form-container">
      <form className="login-form" onSubmit={submit}>
        <h2>Admin Login</h2>
        <div className="form-group">
          <label htmlFor="admin-password">Admin Password:</label>
          <div className="password-field-wrap">
            <input
              id="admin-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin password"
              disabled={isLoading}
              onBlur={() => setTouched(true)}
              ref={passwordRef}
            />
            <button
              type="button"
              className="password-field-toggle"
              onClick={toggleVisibility}
              onMouseDown={(e) => e.preventDefault()}
              disabled={isLoading}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <EyeIcon concealed={!showPassword} />
            </button>
          </div>
        </div>
        {error && <div className="error-message" aria-live="assertive">{error}</div>}
        {!error && touched && !password.trim() && (
          <div className="error-message">Password required</div>
        )}
  <button type="submit" disabled={disabled} className="login-btn">
          {isLoading ? 'Authorizing...' : 'Login'}
        </button>
        <div className="alt-links">
          <button type="button" className="secondary-btn" onClick={onBack}>Back</button>
        </div>
      </form>
    </div>
  );
};

export default AdminLoginForm;
