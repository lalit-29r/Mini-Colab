// App: orchestrates auth flow (user/admin), image selection, workspace (files/editor/terminal), and notifications.
import React, { useState, useCallback, useEffect } from 'react';
import './App.css';
import LoginForm from './components/LoginForm';
import AdminLoginForm from './components/AdminLoginForm';
import AdminDashboard from './components/AdminDashboard';
import ImageSelection from './components/ImageSelection';
import CodeEditor from './components/CodeEditor';
import Terminal from './components/Terminal';
import FileExplorer from './components/FileExplorer';
import ActivityBar from './components/ActivityBar';
import { apiService } from './services/api';
import ConfirmDialog from './components/ConfirmDialog';
import Notifications, { Notice } from './components/Notifications';

interface User {
  username: string;
  containerID?: string; // Will be set after image selection
}

interface FileCache {
  [filePath: string]: {
    content: string;
    savedContent: string;
    hasUnsavedChanges: boolean;
  };
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [currentFilename, setCurrentFilename] = useState<string>('');
  const [commandToExecute, setCommandToExecute] = useState<string>('');
  const [executionKey, setExecutionKey] = useState<number>(0);
  const [currentFileContent, setCurrentFileContent] = useState<string>('');
  const [currentFileSavedContent, setCurrentFileSavedContent] = useState<string>('');
  const [currentFilePath, setCurrentFilePath] = useState<string>('');
  const [isFileOpen, setIsFileOpen] = useState<boolean>(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  const [fileCache, setFileCache] = useState<FileCache>({});
  const [filesWithUnsavedChanges, setFilesWithUnsavedChanges] = useState<Set<string>>(new Set());
  const [editorFocusRequest, setEditorFocusRequest] = useState<number>(0);
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState<boolean>(false);
  const [terminalMinimized, setTerminalMinimized] = useState<boolean>(true); // start hidden
  const [terminalActivated, setTerminalActivated] = useState<boolean>(false); // Lazy mount flag
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(false);
  const [activeActivity, setActiveActivity] = useState<'explorer'>('explorer');
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const restoreTerminal = () => {
    setTerminalMinimized(false);
    // Let layout settle then trigger a resize so Monaco/xterm can refit
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 50);
  };

  const [pendingUsername, setPendingUsername] = useState<string>('');
  const [stage, setStage] = useState<'login'|'image'|'workspace'|'admin-login'|'admin-dashboard'>('login');
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminAuthError, setAdminAuthError] = useState<string>('');
  const [adminLoginLoading, setAdminLoginLoading] = useState<boolean>(false);
  const [confirmAdminLogoutOpen, setConfirmAdminLogoutOpen] = useState<boolean>(false);
  const changePasswordTriggerRef = React.useRef<(() => void) | null>(null);
  const [adminPasswordBusy, setAdminPasswordBusy] = useState<boolean>(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [bootstrapping, setBootstrapping] = useState<boolean>(true); // hide UI until session restored

  // ---- Persistence keys ----
  const LS_USER_KEY = 'mc_user';            // JSON: { username, containerID? }
  const LS_STAGE_KEY = 'mc_stage';          // 'image' | 'workspace'
  const LS_ADMIN_TOKEN_KEY = 'mc_admin_token';
  const LS_ADMIN_EXP_KEY = 'mc_admin_exp';  // epoch ms

  // Persist user stage (only for workspace/image) & data
  const persistUser = (u: User | null, st?: 'image' | 'workspace') => {
    try {
      if (u) {
        localStorage.setItem(LS_USER_KEY, JSON.stringify(u));
        if (st) localStorage.setItem(LS_STAGE_KEY, st);
      } else {
        localStorage.removeItem(LS_USER_KEY);
        localStorage.removeItem(LS_STAGE_KEY);
      }
    } catch {/* ignore quota/unavailable */}
  };
  const persistAdminToken = (token: string | null, ttlSeconds?: number) => {
    try {
      if (token) {
        localStorage.setItem(LS_ADMIN_TOKEN_KEY, token);
        if (ttlSeconds) {
          const exp = Date.now() + ttlSeconds * 1000;
            localStorage.setItem(LS_ADMIN_EXP_KEY, String(exp));
        }
      } else {
        localStorage.removeItem(LS_ADMIN_TOKEN_KEY);
        localStorage.removeItem(LS_ADMIN_EXP_KEY);
      }
    } catch {/* ignore */}
  };

  // ---- Restore session on first mount ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let adminRestored = false;
      try {
        const token = localStorage.getItem(LS_ADMIN_TOKEN_KEY);
        const expStr = localStorage.getItem(LS_ADMIN_EXP_KEY);
        if (token && expStr && Date.now() < Number(expStr)) {
          try {
            await apiService.adminStats(token);
            if (!cancelled) {
              setAdminToken(token);
              setStage('admin-dashboard');
              adminRestored = true;
            }
          } catch {
            persistAdminToken(null);
          }
        }
      } catch {/* ignore */}

      if (!adminRestored) {
        try {
          const raw = localStorage.getItem(LS_USER_KEY);
          if (raw) {
            const parsed: User = JSON.parse(raw);
            if (parsed?.username) {
              try {
                const auth = await apiService.auth(parsed.username);
                if (!cancelled) {
                  const hasContainer = Boolean(auth.has_container && auth.container_id);
                  if (hasContainer) {
                    const u: User = { username: auth.username, containerID: auth.container_id! };
                    setUser(u);
                    setStage('workspace');
                    persistUser(u, 'workspace');
                  } else {
                    setUser(null);
                    setPendingUsername('');
                    setStage('login');
                    persistUser(null);
                  }
                }
              } catch {
                persistUser(null);
              }
            }
          }
        } catch {/* ignore */}
      }
      if (!cancelled) setBootstrapping(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushNotice = React.useCallback((n: Omit<Notice, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setNotices(prev => [...prev, { id, ttlMs: 8000, ...n }]);
  }, []);
  const dismissNotice = React.useCallback((id: string) => {
    setNotices(prev => prev.filter(n => n.id !== id));
  }, []);

  const handleLogin = (userData: { username: string; hasContainer?: boolean; containerID?: string | null }) => {
    setPendingUsername(userData.username);
    // Always reset terminal UI state on a fresh login so it doesn't auto-mount from a previous session
    setTerminalActivated(false);
    setTerminalMinimized(true);
    if (userData.hasContainer && userData.containerID) {
      // Resume existing workspace directly
      setUser({ username: userData.username, containerID: userData.containerID });
      setStage('workspace');
      persistUser({ username: userData.username, containerID: userData.containerID }, 'workspace');
    } else {
      // Proceed to image selection flow
      setUser({ username: userData.username });
      setStage('image');
      persistUser({ username: userData.username }, 'image');
    }
  };

  const handleImageChosen = (info: { image: string; containerID: string }) => {
    // Image name no longer displayed; we only persist container ID
    setUser({ username: pendingUsername || user?.username || '', containerID: info.containerID });
    setStage('workspace');
    const uname = pendingUsername || user?.username || '';
    if (uname) persistUser({ username: uname, containerID: info.containerID }, 'workspace');
  };

  // If stage ever changes away from workspace (e.g., user navigates), ensure terminal not auto-mounted
  React.useEffect(() => {
    if (stage !== 'workspace') {
      setTerminalActivated(false);
      setTerminalMinimized(true);
    }
  }, [stage]);

  const handleAdminSelect = () => {
    setStage('admin-login');
    setAdminAuthError('');
    // Reset any lingering terminal state when switching to admin flow
    setTerminalActivated(false);
    setTerminalMinimized(true);
  };

  const handleAdminLogin = async (password: string) => {
    try {
      setAdminAuthError('');
      setAdminLoginLoading(true);
      const resp = await apiService.adminLogin(password);
      setAdminToken(resp.token);
      setStage('admin-dashboard');
      persistAdminToken(resp.token, resp.ttl_seconds);
    } catch (e: any) {
      setAdminAuthError(e?.response?.data?.detail || e.message || 'Login failed');
    } finally {
      setAdminLoginLoading(false);
    }
  };

  const handleAdminLogout = () => {
    setAdminToken(null);
    setStage('login');
    setTerminalActivated(false);
    setTerminalMinimized(true);
    persistAdminToken(null);
  };
  const requestAdminLogout = () => setConfirmAdminLogoutOpen(true);
  const cancelAdminLogout = () => setConfirmAdminLogoutOpen(false);
  const confirmAdminLogout = () => {
    setConfirmAdminLogoutOpen(false);
    handleAdminLogout();
  };

  useEffect(() => {
    if (stage !== 'admin-dashboard') {
      setAdminPasswordBusy(false);
      changePasswordTriggerRef.current = null;
    }
  }, [stage]);

  const doLogout = async () => {
    if (!user) return;
    
    try {
      await apiService.logout(user.username);
      
      console.log('Logout successful - container and files deleted');
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Clear local state regardless of API success/failure
      setUser(null);
      setCurrentFilename('');
      setCurrentFilePath('');
      setCurrentFileContent('');
      setIsFileOpen(false);
      setCommandToExecute('');
      setExecutionKey(0);
      // Ensure terminal does not auto-start on next login
      setTerminalActivated(false);
      setTerminalMinimized(true);
    }
  };

  const handleLogout = () => setConfirmLogoutOpen(true);
  const cancelLogout = () => setConfirmLogoutOpen(false);
  const confirmLogout = async () => {
    setConfirmLogoutOpen(false);
    // If container not yet started (stage != workspace), just reset local state without API call
    if (stage !== 'workspace' || !user?.containerID) {
      setUser(null);
      setPendingUsername('');
      setStage('login');
      setCurrentFilename('');
      setCurrentFilePath('');
      setCurrentFileContent('');
      setIsFileOpen(false);
      setCommandToExecute('');
      setExecutionKey(0);
      setTerminalActivated(false);
      setTerminalMinimized(true);
      return;
    }
    await doLogout();
    setPendingUsername('');
    setStage('login');
    persistUser(null);
  };

  const handleSaveFile = useCallback((filename: string, content: string) => {
    setCurrentFilename(filename);
    setCurrentFileContent(content); // Update current content to match saved content
    setCurrentFileSavedContent(content);
    
    // Update cache to mark file as saved
    if (currentFilePath) {
      setFileCache(prev => ({
        ...prev,
        [currentFilePath]: {
          ...prev[currentFilePath],
          content,
          savedContent: content,
          hasUnsavedChanges: false
        }
      }));
      
      // Remove from unsaved changes set
      setFilesWithUnsavedChanges(prev => {
        const newSet = new Set(prev);
        newSet.delete(currentFilePath);
        return newSet;
      });
      
      setHasUnsavedChanges(false);
    }
  }, [currentFilePath]);

  const handleExecuteCommand = useCallback((command: string) => {
    // Lazily activate terminal on first run
    if (!terminalActivated) {
      setTerminalActivated(true);
      setTerminalMinimized(false);
    }
    if (terminalMinimized) {
      setTerminalMinimized(false);
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
    setCommandToExecute(command);
    setExecutionKey(prev => prev + 1);
  }, [terminalActivated, terminalMinimized]);

  const handleCommandExecuted = useCallback(() => {
    // Reset after execution (optional, for cleanup)
    setCommandToExecute('');
  }, []);

  const handleFileSelect = useCallback(async (filePath: string, fileName: string) => {
    try {
      // Check if we have cached content for this file
      if (fileCache[filePath]) {
        // Use cached content if available
        setCurrentFileContent(fileCache[filePath].content);
        setCurrentFileSavedContent(fileCache[filePath].savedContent);
        setHasUnsavedChanges(fileCache[filePath].hasUnsavedChanges);
      } else {
        // Load from server if not cached
        const response = await apiService.readFile(user!.username, filePath);
        const content = response.content;
        setCurrentFileContent(content);
        setCurrentFileSavedContent(content);
        setHasUnsavedChanges(false);
        
        // Initialize cache for this file
        setFileCache(prev => ({
          ...prev,
          [filePath]: {
            content,
            savedContent: content,
            hasUnsavedChanges: false
          }
        }));
      }
      
      setCurrentFilename(fileName);
      setCurrentFilePath(filePath);
      setIsFileOpen(true);
    } catch (error: any) {
      console.error('Error loading file:', error);
      pushNotice({ type: 'error', title: 'Load Failed', message: `Could not load file: ${error?.response?.data?.detail || error.message || error}` });
    }
  }, [fileCache, user, pushNotice]);

  const handleNewFile = useCallback((filePath: string, fileName: string) => {
    // When a new file is created, open it for editing
    const content = '';
    setCurrentFileContent(content);
    setCurrentFileSavedContent(content);
    setCurrentFilename(fileName);
    setCurrentFilePath(filePath);
    setIsFileOpen(true);
    setHasUnsavedChanges(false);
  // Request focus for the editor specifically for newly created files
  setEditorFocusRequest((n) => n + 1);
    
    // Initialize cache for new file
    setFileCache(prev => ({
      ...prev,
      [filePath]: {
        content,
        savedContent: content,
        hasUnsavedChanges: false
      }
    }));
  }, []);

  const handleFileDeleted = (deletedPath: string) => {
    // Remove from cache: handle both file and folder (by prefix)
    setFileCache(prev => {
      const newCache: FileCache = { ...prev };
      Object.keys(prev).forEach(p => {
        if (p === deletedPath || p.startsWith(deletedPath + '/')) {
          delete newCache[p];
        }
      });
      return newCache;
    });
    
    // Remove from unsaved changes set
    setFilesWithUnsavedChanges(prev => {
      const newSet = new Set(prev);
      Array.from(prev).forEach(p => {
        if (p === deletedPath || p.startsWith(deletedPath + '/')) {
          newSet.delete(p);
        }
      });
      return newSet;
    });
    
    // If the currently open file was deleted or inside deleted folder, close the editor
    if (currentFilePath === deletedPath || currentFilePath.startsWith(deletedPath + '/')) {
      setCurrentFileContent('');
      setCurrentFileSavedContent('');
      setCurrentFilename('');
      setCurrentFilePath('');
      setIsFileOpen(false);
      setHasUnsavedChanges(false);
    }
  };

  const handleFileRenamed = (oldPath: string, newPath: string, newFileName: string, isFolder: boolean) => {
    const normalize = (p: string) => p.replace(/\\/g, '/');
    oldPath = normalize(oldPath);
    newPath = normalize(newPath);

    // Preserve current editor content if open file is affected
    const preserveCurrent = currentFilePath && (currentFilePath === oldPath || (isFolder && currentFilePath.startsWith(oldPath + '/')));

    setFileCache(prev => {
      const newCache: FileCache = { ...prev };

      if (isFolder) {
        // Build a list first to avoid mutating while iterating
        const entries = Object.entries(prev);
        for (const [p, val] of entries) {
          if (p === oldPath || p.startsWith(oldPath + '/')) {
            const updatedPath = newPath + p.slice(oldPath.length);
            if (preserveCurrent && currentFilePath && p === currentFilePath) {
              // Merge current editor buffer for the open file inside the renamed folder
              newCache[updatedPath] = {
                content: currentFileContent,
                savedContent: currentFileSavedContent,
                hasUnsavedChanges: hasUnsavedChanges,
              };
            } else {
              newCache[updatedPath] = val;
            }
            delete newCache[p];
          }
        }
      } else {
        if (prev[oldPath]) {
          // If the currently open file is the one being renamed, merge the latest editor content
          const merged = { ...prev[oldPath] };
          if (preserveCurrent) {
            merged.content = currentFileContent;
            merged.savedContent = currentFileSavedContent;
            merged.hasUnsavedChanges = hasUnsavedChanges;
          }
          newCache[newPath] = merged;
          delete newCache[oldPath];
        }
      }

      return newCache;
    });

    // Update unsaved changes set
    setFilesWithUnsavedChanges(prev => {
      const newSet = new Set(prev);
      if (isFolder) {
        const toMove: string[] = [];
        newSet.forEach(p => {
          if (p === oldPath || p.startsWith(oldPath + '/')) toMove.push(p);
        });
        toMove.forEach(p => {
          newSet.delete(p);
          const updatedPath = newPath + p.slice(oldPath.length);
          newSet.add(updatedPath);
        });
      } else {
        if (newSet.has(oldPath)) {
          newSet.delete(oldPath);
          newSet.add(newPath);
        }
      }
      return newSet;
    });

    // Update current file state if needed
    if (preserveCurrent && currentFilePath) {
      const updatedPath = isFolder ? newPath + currentFilePath.slice(oldPath.length) : newPath;
      setCurrentFilePath(updatedPath);
      const nameForHeader = isFolder ? updatedPath.split('/').pop() || '' : newFileName;
      setCurrentFilename(nameForHeader);

      // Keep current content/savedContent/unsavedChange flags as-is
      // since the editor is already showing the correct content
    }
  };

  const handleContentChange = useCallback((hasChanges: boolean, content: string) => {
    setHasUnsavedChanges(hasChanges);
    // Keep current editor content in sync so renames don't reset the editor buffer
    setCurrentFileContent(content);
    
    // Update the global set of files with unsaved changes
    if (currentFilePath) {
      setFilesWithUnsavedChanges(prev => {
        const newSet = new Set(prev);
        if (hasChanges) {
          newSet.add(currentFilePath);
        } else {
          newSet.delete(currentFilePath);
        }
        return newSet;
      });
      
      // Update the file cache with current content
      setFileCache(prev => {
        const existing = prev[currentFilePath];
        const nextEntry = existing ? {
          ...existing,
          content,
          hasUnsavedChanges: hasChanges,
        } : {
          content,
          savedContent: content,
          hasUnsavedChanges: hasChanges,
        };
        return {
          ...prev,
          [currentFilePath]: nextEntry,
        };
      });
    }
  }, [currentFilePath]);

  // Handler to explicitly show terminal via button
  const activateTerminal = () => {
    if (!terminalActivated) {
      setTerminalActivated(true);
    }
    setTerminalMinimized(false);
    // trigger layout recalculation for xterm after a tick
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  };

  const toggleExplorer = () => {
    setExplorerCollapsed(prev => !prev);
    // Give layout a tick then notify Monaco/xterm to relayout
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  };

  // Responsive breakpoint detection
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 900;
      setIsMobile(mobile);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // When terminal opens on mobile, scroll it into view
  const scrollTerminalIntoView = useCallback(() => {
    if (!isMobile || !terminalActivated || terminalMinimized) return;
    const section = document.querySelector('.terminal-section');
    if (!(section instanceof HTMLElement)) return;
    try {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}

    const scrollContainers: HTMLElement[] = [];
    const workPane = document.querySelector('.work-pane.column');
    if (workPane instanceof HTMLElement) scrollContainers.push(workPane);

    // Fallback to window for browsers that don't scroll nested containers
    if (scrollContainers.length === 0) {
      const docEl = document.scrollingElement as HTMLElement | null;
      if (docEl) {
        scrollContainers.push(docEl);
      } else if (document.body) {
        scrollContainers.push(document.body);
      }
    }

    // Nudge up a little so the header (with actions) remains visible
    scrollContainers.forEach(container => {
      setTimeout(() => {
        try {
          if (typeof container.scrollBy === 'function') {
            container.scrollBy({ top: -48, behavior: 'smooth' });
          }
        } catch {}
      }, 200);
    });
  }, [isMobile, terminalActivated, terminalMinimized]);

  useEffect(() => {
    scrollTerminalIntoView();
  }, [scrollTerminalIntoView]);

  if (bootstrapping) {
    return (
      <div className="App">
        <main className="App-main bootstrapping-center">
          <div className="bootstrapping-msg">Restoring session…</div>
        </main>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="App-header" role="banner">
        <div className="app-branding" aria-label="Application title">
          <div className="brand-mark" aria-hidden="true">
            <span className="mark-core" />
          </div>
          <h1>miniColab</h1>
        </div>
        {user ? (
          <div className="user-info">
            <span>Welcome, {user.username}!</span>
            <button 
              onClick={handleLogout} 
              className="logout-btn"
              title="Logout"
            >
              Logout
            </button>
          </div>
        ) : stage === 'admin-dashboard' && adminToken ? (
          <div className="user-info">
            <span>Admin</span>
            <button
              type="button"
              onClick={() => changePasswordTriggerRef.current?.()}
              className="change-password-btn"
              title="Change password"
              disabled={adminPasswordBusy}
            >
              Change Password
            </button>
            <button
              type="button"
              onClick={requestAdminLogout}
              className="logout-btn"
              title="Logout"
            >
              Logout
            </button>
          </div>
        ) : null}
      </header>

      <main className="App-main">
        {stage === 'login' && !user && (
          <LoginForm onLogin={handleLogin} onAdminSelect={handleAdminSelect} />
        )}
        {stage === 'admin-login' && (
          <AdminLoginForm
            onLogin={handleAdminLogin}
            onBack={() => setStage('login')}
            error={adminAuthError}
            isLoading={adminLoginLoading}
          />
        )}
        {stage === 'admin-dashboard' && adminToken && (
          <div className="admin-dashboard-wrapper">
            <AdminDashboard
              token={adminToken}
              changePasswordTrigger={changePasswordTriggerRef}
              onPasswordBusyChange={setAdminPasswordBusy}
              pushNotice={pushNotice}
            />
          </div>
        )}
        {stage === 'image' && (pendingUsername || user) && (
          <ImageSelection
            username={pendingUsername || user!.username}
            onImageChosen={handleImageChosen}
          />
        )}
        {stage === 'workspace' && user && (
          <div className="editor-container">
            <ActivityBar
              active={activeActivity}
              sidebarVisible={!explorerCollapsed}
              onSelect={(v) => setActiveActivity(v)}
              onToggleSidebar={toggleExplorer}
            />
            <div className={`file-explorer-section ${explorerCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''}`}>
              {activeActivity === 'explorer' && (
                <FileExplorer 
                  username={user.username}
                  onFileSelect={handleFileSelect}
                  onNewFile={handleNewFile}
                  onFileDeleted={handleFileDeleted}
                  onFileRenamed={handleFileRenamed}
                  currentFilePath={currentFilePath}
                  filesWithUnsavedChanges={filesWithUnsavedChanges}
                  pushNotice={pushNotice}
                />
              )}
            </div>
            {isMobile && !explorerCollapsed && (
              <div className="overlay-backdrop" onClick={toggleExplorer} />
            )}
            <div className={`work-pane ${isMobile ? 'column' : 'row'}`}>
              <div className="code-section">
                <CodeEditor 
                  username={user.username}
                  onSaveFile={handleSaveFile}
                  onExecuteCommand={handleExecuteCommand}
                  initialContent={currentFileContent}
                  savedContent={currentFileSavedContent}
                  filename={currentFilename}
                  filePath={currentFilePath}
                  isFileOpen={isFileOpen}
                  onContentChange={handleContentChange}
                  pushNotice={pushNotice}
                  focusRequest={editorFocusRequest}
                  onQuotaExceeded={async () => {
                    try {
                      const q = await apiService.quotaUsage(user.username);
                      pushNotice({
                        type: 'info',
                        title: 'Storage Usage',
                        message: `Using ${(q.used_bytes/1024/1024).toFixed(2)} MB of ${(q.quota_bytes/1024/1024).toFixed(2)} MB (${q.percent_used}% ).`
                      });
                    } catch {}
                  }}
                />
              </div>
              {terminalActivated && (
                <div className={`terminal-section ${terminalMinimized ? 'minimized' : ''}`}>
                  <Terminal 
                    username={user.username}
                    commandToExecute={commandToExecute}
                    executionKey={executionKey}
                    onCommandExecuted={handleCommandExecuted}
                    minimized={terminalMinimized}
                    onToggleMinimize={() => setTerminalMinimized((m) => !m)}
                  />
                </div>
              )}
            </div>
              {/* Floating button used both for first activation and restore */}
              {(!terminalActivated || (terminalActivated && terminalMinimized)) && (
                <button
                  className="terminal-fab"
                  onClick={() => {
                    if (!terminalActivated) {
                      activateTerminal();
                    } else {
                      restoreTerminal();
                    }
                  }}
                  title="Terminal"
                  aria-label="Terminal"
                >
                  <i className="codicon codicon-terminal" />
                </button>
              )}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={confirmLogoutOpen}
        title="Logout"
        message={stage === 'workspace' && user?.containerID ? 'Logout will stop your container and delete your files. Continue?' : 'Confirm logout?'}
        confirmText={stage === 'workspace' && user?.containerID ? 'Logout & Delete' : 'Logout'}
        cancelText="Cancel"
        destructive={stage === 'workspace' && !!user?.containerID}
        onConfirm={confirmLogout}
        onCancel={cancelLogout}
      />
      <ConfirmDialog
        open={confirmAdminLogoutOpen}
        title="Admin Logout"
        message="Confirm Logout?"
        confirmText="Logout"
        cancelText="Cancel"
        destructive={false}
        onConfirm={confirmAdminLogout}
        onCancel={cancelAdminLogout}
      />
      <Notifications notices={notices} onDismiss={dismissNotice} />
    </div>
  );
}

export default App;
