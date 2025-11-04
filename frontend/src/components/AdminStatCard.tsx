// AdminStatCard: small metric display tile.
import React from 'react';
// Use the main admin dashboard stylesheet
import './AdminDashboard.css';

interface AdminStatCardProps {
  label: string;
  value: string | number;
  subLabel?: string;
  accent?: 'blue' | 'green' | 'purple' | 'orange' | 'red';
}

const AdminStatCard: React.FC<AdminStatCardProps> = ({ label, value, subLabel, accent = 'blue' }) => {
  return (
    <div className={`adm-stat-card accent-${accent}`}>
      <div className="adm-stat-label">{label}</div>
      <div className="adm-stat-value">{value}</div>
      {subLabel && <div className="adm-stat-sub">{subLabel}</div>}
    </div>
  );
};

export default AdminStatCard;
