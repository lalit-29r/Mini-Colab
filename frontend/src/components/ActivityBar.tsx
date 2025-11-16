import React from 'react';
import './ActivityBar.css';

type ActivityView = 'explorer';

interface ActivityBarProps {
  active: ActivityView;
  sidebarVisible: boolean;
  onSelect: (view: ActivityView) => void;
  onToggleSidebar: () => void;
}

const ActivityBar: React.FC<ActivityBarProps> = ({ active, sidebarVisible, onSelect, onToggleSidebar }) => {
  return (
    <nav className="activity-bar" aria-label="Primary">
      <button
        type="button"
        className={`activity-item ${active === 'explorer' ? 'active' : ''}`}
        title={sidebarVisible ? 'Hide Explorer' : 'Show Explorer'}
        aria-label="Explorer"
        onClick={() => {
          onSelect('explorer');
          onToggleSidebar();
        }}
      >
        <i className="codicon codicon-files" />
      </button>

      <div className="activity-spacer" />
    </nav>
  );
};

export default ActivityBar;
