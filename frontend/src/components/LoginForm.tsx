// LoginForm: user auth (requests container presence data) + admin mode switch.
import React, { useState } from 'react';
import { apiService } from '../services/api';
import './LoginForm.css';

interface LoginFormProps {
  onLogin: (user: { username: string; hasContainer?: boolean; containerID?: string | null }) => void;
  onAdminSelect?: () => void;
}

const LoginForm: React.FC<LoginFormProps> = ({ onLogin, onAdminSelect }) => {
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('Please enter a username');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await apiService.auth(username.trim());
      onLogin({
        username: response.username,
        hasContainer: response.has_container,
        containerID: response.container_id,
      });
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to login. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-form-container">
      <form className="login-form" onSubmit={handleSubmit}>
  <h2>Login</h2>
        <div className="form-group">
          <label htmlFor="username">Username:</label>
          <input
            type="text"
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username"
            disabled={isLoading}
          />
        </div>
        {error && <div className="error-message">{error}</div>}
        <button type="submit" disabled={isLoading} className="login-btn">
          {isLoading ? 'Authorizing...' : 'Continue'}
        </button>
        <div className="alt-links">
          <button type="button" className="admin-link" onClick={onAdminSelect}>Admin Login</button>
        </div>
      </form>
    </div>
  );
};

export default LoginForm;
