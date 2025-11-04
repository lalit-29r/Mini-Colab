// AdminLoginForm: password-based admin auth form.
import React, { useState } from 'react';
import './LoginForm.css';

interface AdminLoginFormProps {
  onLogin: (password: string) => void;
  onBack: () => void;
  error?: string;
  isLoading?: boolean;
}

const AdminLoginForm: React.FC<AdminLoginFormProps> = ({ onLogin, onBack, error = '', isLoading = false }) => {
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

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
          <input
            id="admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter admin password"
            disabled={isLoading}
            onBlur={() => setTouched(true)}
          />
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
