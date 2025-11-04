// Notifications: transient toast stack with optional action & TTL auto-dismiss.
import React from 'react';
import './Notifications.css';

export interface Notice {
  id: string;
  type: 'info' | 'success' | 'error' | 'warning';
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  ttlMs?: number; // auto-dismiss
}

interface NotificationsProps {
  notices: Notice[];
  onDismiss: (id: string) => void;
}

const Notifications: React.FC<NotificationsProps> = ({ notices, onDismiss }) => {
  React.useEffect(() => {
    const timers = notices.map(n => {
      if (!n.ttlMs) return null;
      return setTimeout(() => onDismiss(n.id), n.ttlMs);
    });
    return () => { timers.forEach(t => t && clearTimeout(t)); };
  }, [notices, onDismiss]);

  return (
    <div className="notifications-container" role="region" aria-label="Notifications">
      {notices.map(n => (
        <div key={n.id} className={`notice notice-${n.type}`}>
          <div className="notice-content">
            {n.title && <div className="notice-title">{n.title}</div>}
            <div className="notice-message">{n.message}</div>
          </div>
          <div className="notice-actions">
            {n.onAction && n.actionLabel && (
              <button className="notice-action" onClick={() => n.onAction && n.onAction()}>{n.actionLabel}</button>
            )}
            <button className="notice-close" aria-label="Dismiss" onClick={() => onDismiss(n.id)}>×</button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default Notifications;
