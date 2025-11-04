// AdminDashboard: real-time container + job view via WS, with quota edit & process kill.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import './AdminDashboard.css';
import ConfirmDialog from './ConfirmDialog';
import QuotaEditorDialog from './QuotaEditorDialog';
import AdminStatCard from './AdminStatCard';
import { apiService } from '../services/api';

interface AdminStatsOverall {
  containers: number;
  total_cpu_percent: number;
  total_mem_usage: number; // bytes
  total_mem_percent: number;
}

interface AdminJobRow {
  pid: number;
  command: string;
  elapsed_seconds: number;
  // Backend still sends these but we no longer display them
  cpu_percent?: number;
  mem_percent?: number;
}

interface AdminUserRow {
  username: string;
  container_id: string;
  status: string;
  cpu_percent: number;
  mem_usage: number; // bytes
  mem_percent: number;
  workspace_size: number; // bytes
  quota_bytes?: number;
  shell_pid?: number | null;
  jobs?: AdminJobRow[];
}

interface AdminStatsResponse {
  overall: AdminStatsOverall;
  users: AdminUserRow[];
}

interface AdminDashboardProps {
  token: string;
  onLogout: () => void;
}

type SortKey = 'username' | 'cpu' | 'mem' | 'storage' | 'status';

const formatBytes = (b: number) => {
  if (!b) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDuration = (s: number) => {
  if (!s && s !== 0) return '';
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
};

// Stable helpers to minimize re-renders/flicker
const shallowEqual = (a: any, b: any) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};

const mergeStats = (prev: AdminStatsResponse | null, next: AdminStatsResponse): AdminStatsResponse => {
  if (!prev) return next;
  const mapPrev = new Map<string, AdminUserRow>();
  prev.users.forEach(u => mapPrev.set(u.username, u));
  const mergedUsers = next.users.map(u => {
    const p = mapPrev.get(u.username);
    if (p && shallowEqual(p, u)) return p; // reuse to avoid remounts
    return u;
  });
  const mergedOverall = shallowEqual(prev.overall, next.overall) ? prev.overall : next.overall;
  return { overall: mergedOverall, users: mergedUsers };
};

const AdminDashboard: React.FC<AdminDashboardProps> = ({ token, onLogout }) => {
  const [stats, setStats] = useState<AdminStatsResponse | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string>('');
  const [confirmUser, setConfirmUser] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [quotaUser, setQuotaUser] = useState<string | null>(null);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('username');
  const [sortDir, setSortDir] = useState<1|-1>(1);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const [jobActionPid, setJobActionPid] = useState<number | null>(null);
  const [jobKillUser, setJobKillUser] = useState<string | null>(null);
  const [jobKillSignal, setJobKillSignal] = useState<string>('TERM');
  const [jobKillOpen, setJobKillOpen] = useState(false);
  const [killingJobs, setKillingJobs] = useState<Set<string>>(new Set());
  const lastStatsRef = useRef<AdminStatsResponse | null>(null);

  // Stats & jobs websocket
  useEffect(() => {
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(`ws://localhost:8000/admin/ws/stats?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => { reconnectAttempts.current = 0; setError(''); };
      ws.onmessage = ev => {
        try {
          const parsed: AdminStatsResponse = JSON.parse(ev.data);
          // Merge with previous to retain object identity for unchanged rows
          setStats(prev => {
            const merged = mergeStats(prev, parsed);
            lastStatsRef.current = merged;
            return merged;
          });
          // Reconcile killingJobs: remove those whose PID disappeared (kill applied)
          setKillingJobs(prev => {
            if (!prev.size) return prev;
            const active = new Set<string>();
            const userMap = new Map<string, Set<number>>();
            parsed.users.forEach(u => {
              const set = new Set<number>((u.jobs || []).map(j => j.pid));
              userMap.set(u.username, set);
            });
            prev.forEach(key => {
              const [uname, pidStr] = key.split(":", 2);
              const pidNum = Number(pidStr);
              const userPids = userMap.get(uname);
              if (userPids && userPids.has(pidNum)) {
                // Still present -> keep showing Killing…
                active.add(key);
              }
              // If gone -> drop it silently
            });
            return active;
          });
        } catch {/* ignore parse issues */}
      };
      ws.onerror = () => { /* silent */ };
      ws.onclose = () => {
        if (cancelled) return;
        reconnectAttempts.current += 1;
        const delay = Math.min(15000, 800 * Math.pow(2, reconnectAttempts.current - 1));
        setTimeout(connect, delay);
      };
    };
    connect();
    return () => { cancelled = true; try { wsRef.current?.close(); } catch {/* noop */} };
  }, [token]);

  // Collapse panel if its user disappears
  useEffect(() => {
    if (expanded && stats && !stats.users.find(u => u.username === expanded)) {
      setExpanded(null);
    }
  }, [stats, expanded]);

  const filteredUsers = useMemo(() => {
    if (!stats) return [] as AdminUserRow[];
    let rows = stats.users;
    if (filter.trim()) {
      const f = filter.trim().toLowerCase();
      rows = rows.filter(r => r.username.toLowerCase().includes(f));
    }
    const sorted = [...rows].sort((a,b) => {
      switch (sortKey) {
        case 'username': return a.username.localeCompare(b.username) * sortDir;
        case 'cpu': return (a.cpu_percent - b.cpu_percent) * sortDir;
        case 'mem': return (a.mem_percent - b.mem_percent) * sortDir;
        case 'storage': {
          const ap = a.workspace_size / (a.quota_bytes || 1);
          const bp = b.workspace_size / (b.quota_bytes || 1);
          return (ap - bp) * sortDir;
        }
        case 'status': return a.status.localeCompare(b.status) * sortDir;
        default: return 0; // satisfy exhaustive return for comparator
      }
    });
    return sorted;
  }, [stats, filter, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir(d => d === 1 ? -1 : 1);
    } else {
      setSortKey(k); setSortDir(1);
    }
  };

  const requestStopUser = (username: string) => { setConfirmUser(username); setConfirmOpen(true); };
  const cancelStop = () => { setConfirmOpen(false); setTimeout(() => setConfirmUser(null), 150); };
  const confirmStop = async () => {
    if (!confirmUser) return; setConfirmOpen(false); const target = confirmUser; setBusyUser(target);
    try { await apiService.adminStopUser(token, target); if (expanded === target) setExpanded(null); } catch (e:any) { setError(e?.response?.data?.detail || e.message || 'Stop failed'); }
    finally { setBusyUser(''); setConfirmUser(null); }
  };

  const openQuota = (username: string) => { setQuotaUser(username); setQuotaOpen(true); };

  const saveQuota = async (mb: number) => {
    if (!quotaUser) return; setQuotaBusy(true);
    try { await apiService.adminSetQuota(token, quotaUser, mb); setQuotaOpen(false); setQuotaUser(null); }
    catch (e:any) { setError(e?.response?.data?.detail || e.message || 'Quota update failed'); }
    finally { setQuotaBusy(false); }
  };

  const startKillJob = (uname: string, pid: number) => {
    setJobKillUser(uname);
    setJobActionPid(pid);
    setJobKillSignal('TERM');
    setJobKillOpen(true);
  };
  const cancelKillJob = () => { setJobKillOpen(false); setTimeout(()=>{ setJobKillUser(null); setJobActionPid(null); }, 150); };
  const confirmKillJob = async () => {
    if (!jobKillUser || jobActionPid == null) return;
    const uname = jobKillUser; const pid = jobActionPid; const sig = jobKillSignal; const key = `${uname}:${pid}`;
    setJobKillOpen(false);
    setJobKillUser(null);
    setJobActionPid(null);
    // Mark as killing until websocket refresh shows it's gone
    setKillingJobs(prev => { const n = new Set(prev); n.add(key); return n; });
    apiService.adminKillJob(token, uname, pid, sig)
      .catch((e:any) => {
        // On error, remove killing flag (process still present) and show error
        setKillingJobs(prev => { const n = new Set(prev); n.delete(key); return n; });
        setError(e?.response?.data?.detail || e.message || 'Kill failed');
      });
  };

  const overallCards = useMemo(() => {
    if (!stats) return null;
    const avgCpu = stats.overall.containers > 0 ? (stats.overall.total_cpu_percent / stats.overall.containers) : 0;
    const totalMem = stats.overall.total_mem_usage; // bytes
    return (
      <div className="adm-metrics">
        <AdminStatCard label="Active Containers" value={stats.overall.containers} accent="green" />
        <AdminStatCard label="Total CPU" value={stats.overall.total_cpu_percent.toFixed(2)+'%'} subLabel={avgCpu.toFixed(2)+'% avg'} accent="blue" />
        <AdminStatCard label="Mem Used" value={formatBytes(totalMem)} subLabel={stats.overall.total_mem_percent.toFixed(1)+'%'} accent="purple" />
        <AdminStatCard label="Users" value={stats.users.length} accent="orange" />
      </div>
    );
  }, [stats]);

  const renderStorageText = (u: AdminUserRow) => {
    const quota = u.quota_bytes || 50*1024*1024;
    return `${formatBytes(u.workspace_size)} / ${(quota/1024/1024).toFixed(0)} MB`;
  };

  const renderStatus = (s: string) => {
    const cls = 'adm-status ' + (s ? s.toLowerCase() : '');
    return <span className={cls}>{s}</span>;
  };

  const onKeyRow = (e: React.KeyboardEvent, uname: string, isExpanded: boolean) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(isExpanded ? null : uname); }
    if (e.key === 'ArrowRight' && !isExpanded) { setExpanded(uname); }
    if (e.key === 'ArrowLeft' && isExpanded) { setExpanded(null); }
  };

  const renderJobs = (u: AdminUserRow) => {
    const jobs = u.jobs || [];
    if (!jobs.length) {
      return (
        <div className="adm-jobs-list" role="list" aria-label={`Jobs for ${u.username}`}>
          <div className="adm-job-row empty solo" role="listitem">
            <div className="adm-job-main">
              <span className="adm-job-cmd empty-text">No active jobs</span>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="adm-jobs-list" role="list" aria-label={`Jobs for ${u.username}`}>
        {jobs.map(j => {
          const key = `${u.username}:${j.pid}`;
          const isKilling = killingJobs.has(key);
          return (
            <div key={j.pid} className="adm-job-row" role="listitem">
              <div className="adm-job-main">
                <span className="adm-job-pid" title="Process ID">{j.pid}</span>
                <span className="adm-job-cmd" title={j.command}>{j.command}</span>
              </div>
              <div className="adm-job-meta">
                <span className="adm-job-time" title="Elapsed">{formatDuration(j.elapsed_seconds)}</span>
                <button
                  type="button"
                  className="adm-btn danger small"
                  disabled={isKilling}
                  onClick={(e)=>{ e.stopPropagation(); startKillJob(u.username, j.pid); }}
                >{isKilling ? 'Killing…' : 'Kill'}</button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="adm-root">
      <div className="adm-header">
        <h1 className="adm-title">Admin Control Center</h1>
        <div className="adm-actions">
          <button className="adm-btn danger" onClick={onLogout}>Logout</button>
        </div>
      </div>
  {error && <div className="adm-error">{error}</div>}
      <div className="adm-scroll">
        {overallCards}
        <div className="adm-users-panel">
          <div className="adm-users-header">
            <h2 className="adm-users-title">Users</h2>
            <div className="adm-filter-wrap">
              <div className="adm-filter-box">
                <input
                  type="text"
                  placeholder="Search user..."
                  value={filter}
                  aria-label="Filter users by username"
                  onChange={e => setFilter(e.target.value)}
                  className="adm-filter"
                />
                {filter && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    className="adm-filter-clear"
                    onClick={() => setFilter('')}
                  >✕</button>
                )}
              </div>
            </div>
          </div>
          <div className="adm-table-wrap" role="region" aria-label="User statistics table">
            <table className="adm-table">
              <thead>
                <tr>
                  <th className="adm-th-wide"><button type="button" className="adm-sort-btn" onClick={() => toggleSort('username')}>User {sortKey==='username' ? (sortDir===1?'▲':'▼') : ''}</button></th>
                  <th><button type="button" className="adm-sort-btn" onClick={() => toggleSort('status')}>Status {sortKey==='status' ? (sortDir===1?'▲':'▼') : ''}</button></th>
                  <th><button type="button" className="adm-sort-btn" onClick={() => toggleSort('cpu')}>CPU% {sortKey==='cpu' ? (sortDir===1?'▲':'▼') : ''}</button></th>
                  <th><button type="button" className="adm-sort-btn" onClick={() => toggleSort('mem')}>Mem% {sortKey==='mem' ? (sortDir===1?'▲':'▼') : ''}</button></th>
                  <th><button type="button" className="adm-sort-btn" onClick={() => toggleSort('storage')}>Storage {sortKey==='storage' ? (sortDir===1?'▲':'▼') : ''}</button></th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map(u => {
                  const isExpanded = expanded === u.username;
                  return (
                    <React.Fragment key={u.username}>
                      <tr
                        className={`adm-row-main ${isExpanded ? 'expanded' : ''}`}
                        tabIndex={0}
                        onKeyDown={e => onKeyRow(e,u.username,isExpanded)}
                        onClick={() => setExpanded(isExpanded?null:u.username)}
                      >
                        <td className="adm-user-cell">
                          <button
                            type="button"
                            onClick={(e)=>{ e.stopPropagation(); setExpanded(isExpanded?null:u.username); }}
                            className="adm-user-btn"
                          >
                            <span className={`adm-caret ${isExpanded ? 'rot':''}`}>▶</span>
                            {u.username}
                          </button>
                        </td>
                        <td>{renderStatus(u.status)}</td>
                        <td>{u.cpu_percent.toFixed(2)}</td>
                        <td>{u.mem_percent.toFixed(1)}% ({formatBytes(u.mem_usage)})</td>
                        <td>{renderStorageText(u)}</td>
                      </tr>
                      {isExpanded && (
                        <tr className="adm-detail-row" id={`detail-${u.username}`}> 
                          <td colSpan={5}>
                            <div className="adm-detail-surface center-meta" role="group" aria-label="User detail and actions">
                              <div className="adm-detail-meta-block">
                                <span className="adm-detail-label center">Container ID</span>
                                <code className="adm-detail-code center" title={u.container_id}>{u.container_id}</code>
                              </div>
                              <div className="adm-detail-actions-upgraded">
                                  <button type="button" className="adm-btn quota elevated" onClick={()=>openQuota(u.username)}>Edit Storage Quota</button>
                                <button type="button" className="adm-btn danger elevated" disabled={busyUser===u.username} onClick={()=>requestStopUser(u.username)}>{busyUser===u.username?'Working...':'Stop & Delete'}</button>
                              </div>
                              <div className="adm-jobs-section">
                                <h3 className="adm-jobs-title">Jobs</h3>
                                {renderJobs(u)}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {filteredUsers.length===0 && (
                  <tr><td colSpan={5} className="adm-empty">No users match filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Stop & Delete"
        message={confirmUser ? `Stop container and delete workspace for "${confirmUser}"? This cannot be undone.` : ''}
        confirmText="Stop & Delete"
        cancelText="Cancel"
        destructive
        onConfirm={confirmStop}
        onCancel={cancelStop}
      />
      <QuotaEditorDialog
        open={quotaOpen}
        username={quotaUser}
        usageBytes={quotaUser ? (stats?.users.find(u=>u.username===quotaUser)?.workspace_size || 0) : 0}
        quotaBytes={quotaUser ? (stats?.users.find(u=>u.username===quotaUser)?.quota_bytes || 50*1024*1024) : 50*1024*1024}
        busy={quotaBusy}
        onClose={() => { if(!quotaBusy){ setQuotaOpen(false); setQuotaUser(null);} }}
        onSave={saveQuota}
      />
      <ConfirmDialog
        open={jobKillOpen}
        title="Kill Process"
        message={jobActionPid!=null && jobKillUser ? `Kill Process ${jobActionPid} for ${jobKillUser}?` : ''}
        confirmText="Kill"
        cancelText="Cancel"
        destructive
        onConfirm={confirmKillJob}
        onCancel={cancelKillJob}
      />
    </div>
  );
};

export default AdminDashboard;
