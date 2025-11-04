// Terminal: xterm.js instance with lazy connect, resize fitting, kill/revive & minimize.
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { apiService } from '../services/api';
import '@xterm/xterm/css/xterm.css';
import './Terminal.css';

interface TerminalProps {
  username: string;
  commandToExecute?: string;
  executionKey?: number;
  onCommandExecuted?: () => void;
  minimized?: boolean;
  onToggleMinimize?: () => void;
}

const TerminalComponent: React.FC<TerminalProps> = ({ username, commandToExecute, executionKey, onCommandExecuted, minimized = false, onToggleMinimize }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const hiddenRef = useRef<boolean>(minimized);
  const [killed, setKilled] = useState(false);

  // Send a command (slight delay so shell prompt is ready)
  const executeCommand = React.useCallback((command: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && xtermRef.current) {
      // Add a small delay to ensure terminal is ready
      setTimeout(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          // Send the command followed by Enter
          apiService.sendToWebSocket(wsRef.current, { input: command + '\r' });
        }
      }, 500);
    }
  }, []);

  // Trigger execution when a new key+command pair arrives
  React.useEffect(() => {
    if (commandToExecute && isConnected && executionKey) {
      console.log('Executing command:', commandToExecute, 'with key:', executionKey);
      // Ensure terminal gains focus so cursor becomes active immediately
      try { xtermRef.current?.focus(); } catch {}
      executeCommand(commandToExecute);
      
      // Call the callback to reset the command after execution
      if (onCommandExecuted) {
        setTimeout(() => {
          onCommandExecuted();
        }, 500); // Small delay to ensure command is sent
      }
    }
  }, [commandToExecute, executionKey, isConnected, executeCommand, onCommandExecuted]);

  const safeWrite = React.useCallback((text: string) => {
    try {
      const el = terminalRef.current as HTMLDivElement | null;
      if (!el || !xtermRef.current) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        // Try again shortly when layout stabilizes
        setTimeout(() => safeWrite(text), 50);
        return;
      }
      xtermRef.current.write(text);
    } catch (e) {
      console.warn('Deferred write due to layout:', e);
      setTimeout(() => safeWrite(text), 50);
    }
  }, []);

  const connectToTerminal = React.useCallback(() => {
    if (killed) return; // do not reconnect if killed
    if (!xtermRef.current) return;

    wsRef.current = apiService.createTerminalWebSocket(
      (data) => {
        if (xtermRef.current) {
          safeWrite(data);
          // Ensure terminal scrolls to bottom after new content
          setTimeout(() => {
            try { xtermRef.current?.scrollToBottom(); } catch {}
          }, 10);
        }
      },
      () => {
        setIsConnected(false);
        if (xtermRef.current) {
          xtermRef.current.write('\r\n❌ Terminal connection closed\r\n');
          xtermRef.current.scrollToBottom();
        }
      }
    );

    wsRef.current.onopen = () => {
      setIsConnected(true);
      if (xtermRef.current) {
        safeWrite('\r\n🔗 Connected to container terminal\r\n');
        try { xtermRef.current.scrollToBottom(); } catch {}
        // Send username to establish session
        apiService.sendToWebSocket(wsRef.current!, { username });
      }
    };

    wsRef.current.onerror = (error) => {
      setIsConnected(false);
      if (xtermRef.current) {
        safeWrite('\r\n❌ Terminal connection error\r\n');
        try { xtermRef.current.scrollToBottom(); } catch {}
      }
    };
  }, [username, safeWrite, killed]);

  useEffect(() => {
    if (terminalRef.current && !xtermRef.current && !killed) {
  // Create terminal (fit once container has dimensions)
      xtermRef.current = new Terminal({
        fontFamily: 'Consolas, Monaco, "Courier New", monospace',
        fontSize: 14,
        lineHeight: 1.0,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          selectionBackground: '#264f78',
        },
        cursorBlink: true,
        scrollback: 1000,
        convertEol: true,
        allowProposedApi: true,
      });

  // Fit addon
      fitAddonRef.current = new FitAddon();
      xtermRef.current.loadAddon(fitAddonRef.current);

  // Defer open until container has a measurable size
      const containerEl = terminalRef.current;
      const waitAndOpen = () => {
        if (!containerEl || !xtermRef.current) return;
        const rect = containerEl.getBoundingClientRect();
        if (!hiddenRef.current && rect.width > 0 && rect.height > 0) {
          xtermRef.current.open(containerEl);
          afterOpen();
        } else {
          setTimeout(waitAndOpen, 50);
        }
      };

      const afterOpen = () => {
      
  // Focus tracking for style
      const textareaHost = terminalRef.current as HTMLDivElement | null;
      const terminalTextarea = textareaHost?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (terminalTextarea) {
        terminalTextarea.addEventListener('focus', () => {
          setIsFocused(true);
        });
        
        terminalTextarea.addEventListener('blur', () => {
          setIsFocused(false);
        });
      }
      
      // Also add click listener to the terminal container to focus
      const terminalScreen = textareaHost?.querySelector('.xterm-screen');
      if (terminalScreen) {
        terminalScreen.addEventListener('click', () => {
          xtermRef.current?.focus();
        });
      }
      
  // Several fit attempts while layout stabilises
        const performFit = () => {
        if (hiddenRef.current) return; // Skip fitting while hidden
        if (fitAddonRef.current && xtermRef.current) {
          // Ensure container has measurable size
          const el = terminalRef.current as HTMLDivElement | null;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          try {
            fitAddonRef.current.fit();
            // Force refresh of terminal viewport
            xtermRef.current.refresh(0, xtermRef.current.rows - 1);
          } catch (error) {
            console.warn('Terminal fit error:', error);
          }
        }
        };

  // Initial multi-pass fit
        performFit();
        setTimeout(performFit, 50);
        setTimeout(performFit, 150);
        setTimeout(() => {
          performFit();
          if (xtermRef.current) {
            try { xtermRef.current.focus(); } catch {}
            try { xtermRef.current.scrollToBottom(); } catch {}
          }
          // Connect only after layout + with non-empty username (prevents stray auto-start)
          if (username) {
            setTimeout(() => connectToTerminal(), 50);
          }
        }, 300);

  // Shell input → WS
      xtermRef.current?.onData((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          apiService.sendToWebSocket(wsRef.current, { input: data });
        }
      });

  // Window resize (debounced)
      const handleResize = () => {
        if (hiddenRef.current) return;
        if (fitAddonRef.current && xtermRef.current) {
          // Debounce multiple resize calls
          setTimeout(() => {
            if (hiddenRef.current) return;
            if (fitAddonRef.current && xtermRef.current) {
              try {
                const el = terminalRef.current as HTMLDivElement | null;
                if (el) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    fitAddonRef.current.fit();
                    // Force terminal to recalculate viewport
                    xtermRef.current.refresh(0, xtermRef.current.rows - 1);
                    xtermRef.current.scrollToBottom();
                  }
                }
              } catch (error) {
                console.warn('Resize fit error:', error);
              }
            }
          }, 100);
        }
      };
      
        window.addEventListener('resize', handleResize);

  // ResizeObserver for container mutations
        const resizeObserver = new ResizeObserver(() => {
        if (!hiddenRef.current) {
          handleResize();
        }
        });
      
        if (terminalRef.current) {
          resizeObserver.observe(terminalRef.current);
        }

        return () => {
          window.removeEventListener('resize', handleResize);
          resizeObserver.disconnect();

          // Graceful WS close
          try {
            if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
              wsRef.current.close();
            }
          } catch (e) {
            console.warn('Error closing terminal WebSocket during cleanup:', e);
          } finally {
            wsRef.current = null;
          }

          // Dispose xterm
          try {
            xtermRef.current?.dispose();
          } catch (e) {
            console.warn('Error disposing xterm during cleanup:', e);
          } finally {
            xtermRef.current = null;
            fitAddonRef.current = null;
          }
        };
      };

      // Attempt to open when container is ready
      waitAndOpen();
    }
  }, [username, connectToTerminal, killed]);

  const killTerminal = () => {
    try {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        wsRef.current.close();
      }
    } catch (e) {
      console.warn('Error closing WS on kill', e);
    } finally {
      wsRef.current = null;
    }
    try {
      xtermRef.current?.write('\r\n⚠️ Terminal killed by user.\r\n');
    } catch {}
    try {
      xtermRef.current?.dispose();
    } catch {}
    xtermRef.current = null;
    fitAddonRef.current = null;
    setIsConnected(false);
    setKilled(true);
    // Also hide the panel similar to minimize behavior
    if (!minimized && onToggleMinimize) {
      onToggleMinimize();
    }
  };

  const reviveTerminal = () => setKilled(false);

  // Revive if user reopens after kill
  useEffect(() => {
    if (!minimized && killed) {
      reviveTerminal();
    }
  }, [minimized, killed]);

  // On restore perform fit
  useEffect(() => {
    hiddenRef.current = minimized;
    if (!minimized) {
      // After becoming visible, perform a fit to recompute dimensions
      setTimeout(() => {
        try {
          if (fitAddonRef.current && xtermRef.current) {
            const el = terminalRef.current as HTMLDivElement | null;
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                fitAddonRef.current.fit();
                xtermRef.current.refresh(0, xtermRef.current.rows - 1);
                xtermRef.current.scrollToBottom();
              }
            }
          }
        } catch (e) {
          console.warn('Fit after restore failed:', e);
        }
      }, 80);
    }
  }, [minimized]);

  return (
    <div className="terminal-panel">
      <div className={`terminal-window ${isFocused ? 'focused' : ''} ${minimized ? 'is-minimized' : ''}`}>
        <div className="terminal-header">
          {minimized ? (
            <div className="terminal-title compact" title="Container Terminal">
              <span>🖥️</span>
            </div>
          ) : (
            <div className="terminal-title">
              <span>🖥️ Container Terminal</span>
              <div className="connection-status">
                <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
                  {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
                </span>
              </div>
            </div>
          )}
          <div className="terminal-actions">
            {!killed && (
              <button className="terminal-minimize-btn" onClick={onToggleMinimize} title={minimized ? 'Restore terminal' : 'Minimize terminal'} aria-label={minimized ? 'Restore terminal' : 'Minimize terminal'}>
                <i className={`codicon ${minimized ? 'codicon-chevron-up' : 'codicon-chrome-minimize'}`} />
              </button>
            )}
            {!killed && (
              <button className="terminal-kill-btn" onClick={killTerminal} title="Kill terminal" aria-label="Kill terminal">
                <i className="codicon codicon-close" />
              </button>
            )}
            {killed && (
              <button className="terminal-revive-btn" onClick={reviveTerminal} title="Restart terminal" aria-label="Restart terminal">
                <i className="codicon codicon-debug-restart" />
              </button>
            )}
          </div>
        </div>
        <div className={`terminal-body ${minimized ? 'hidden' : ''}`}>
          <div ref={terminalRef} className="xterm-container" />
        </div>
      </div>
    </div>
  );
};

export default TerminalComponent;