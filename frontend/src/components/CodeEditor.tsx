/* CodeEditor: Monaco wrapper with unsaved tracking & run/save actions (Python focused). */
import React, { useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { apiService } from '../services/api';
import './CodeEditor.css';
import { FileIcon } from './Icons';
import ConfirmDialog from './ConfirmDialog';

interface CodeEditorProps {
  username: string;
  onSaveFile: (filename: string, content: string) => void;
  onExecuteCommand: (command: string) => void;
  initialContent?: string;
  savedContent?: string;
  filename?: string;
  filePath?: string;
  isFileOpen?: boolean;
  onContentChange?: (hasUnsavedChanges: boolean, content: string) => void;
  onQuotaExceeded?: (info: { limitBytes: number; filePath: string }) => void;
  pushNotice?: (n: { type: 'info'|'success'|'error'|'warning'; title?: string; message: string; actionLabel?: string; onAction?: () => void }) => void;
  // When this value changes (increments), the editor will be focused. Used for new-file auto-focus.
  focusRequest?: number;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ 
  username, 
  onSaveFile,
  onExecuteCommand,
  initialContent,
  savedContent,
  filename,
  filePath,
  isFileOpen = false,
  onContentChange,
  onQuotaExceeded,
  pushNotice,
  focusRequest
}) => {
  const [code, setCode] = useState(initialContent || '');
  const [internalSavedContent, setInternalSavedContent] = useState(savedContent || initialContent || '');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const editorRef = useRef<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const suppressProgrammaticChange = useRef(false);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  // Refs for latest callbacks to avoid stale closures in Monaco addCommand
  const saveCbRef = useRef<(() => Promise<void> | void) | null>(null);
  const runCbRef = useRef<(() => Promise<void> | void) | null>(null);
  // Refs to avoid listing these in deps where not required by behavior
  const isFileOpenRef = useRef<boolean>(isFileOpen);
  const filePathRef = useRef<string | undefined>(filePath);


  // Blank model when no file open (prevents churn)
  const displayContent = isFileOpen ? code : '';

  // Sync editor when switching/opening files
  React.useLayoutEffect(() => {
    if (isFileOpen && initialContent !== undefined) {
      // Normalize line endings when setting initial content
      const normalizedContent = initialContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const normalizedSavedContent = (savedContent || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      
      // Suppress onContentChange for this programmatic update
      suppressProgrammaticChange.current = true;
      setCode(normalizedContent);
      setInternalSavedContent(normalizedSavedContent);
      setHasUnsavedChanges(normalizedContent !== normalizedSavedContent);
    } else if (!isFileOpen) {
      suppressProgrammaticChange.current = true;
      setCode('');
      setInternalSavedContent('');
      setHasUnsavedChanges(false);
    }
  }, [initialContent, savedContent, isFileOpen, filePath]);

  // Derive unsaved state (parent notified in onChange)
  React.useEffect(() => {
    if (suppressProgrammaticChange.current) {
      suppressProgrammaticChange.current = false;
      return;
    }
    const hasChanges = isFileOpen && code !== internalSavedContent;
    setHasUnsavedChanges(hasChanges);
    // Parent is notified directly from onChange to avoid race conditions when switching files
  }, [code, internalSavedContent, isFileOpen]);

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    
  // Python diagnostics
    monaco.languages.python?.pythonDefaults?.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

  // Force LF line endings
    const model = editor.getModel();
    if (model) {
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
    }

    // Bind Ctrl/Cmd+S to save
    try {
      const KeyMod = monaco.KeyMod;
      const KeyCode = monaco.KeyCode;
      editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, async () => {
        // Prevent the browser's default save dialog
        try { (window.event as any)?.preventDefault?.(); } catch {}
        const fn = saveCbRef.current;
        if (fn) await fn();
      });
      // Bind Ctrl/Cmd+Enter to run
      editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, async () => {
        try { (window.event as any)?.preventDefault?.(); } catch {}
        const fn = runCbRef.current;
        if (fn) await fn();
      });
    } catch {}
  };

  // Global fallback: handle Ctrl/Cmd+S when the Monaco editor has focus (use ref to avoid stale deps)
  React.useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      const isSave = (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S');
      if (!isSave) return;
      const hasFocus = !!editorRef.current && editorRef.current.hasTextFocus?.();
      if (!hasFocus) return;
      e.preventDefault();
      const fn = saveCbRef.current;
      if (fn) await fn();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Keep refs updated
  React.useEffect(() => { isFileOpenRef.current = isFileOpen; }, [isFileOpen]);
  React.useEffect(() => { filePathRef.current = filePath; }, [filePath]);

  // Focus the editor when a new file is created (signaled via focusRequest)
  React.useEffect(() => {
    if (typeof focusRequest === 'number') {
      // Defer slightly to ensure editor has mounted for the new file
      setTimeout(() => {
        const hasFile = isFileOpenRef.current && !!filePathRef.current;
        if (editorRef.current && hasFile) {
          try { editorRef.current.focus?.(); } catch {}
        }
      }, 0);
    }
  }, [focusRequest]);

  // Global fallback: handle Ctrl/Cmd+Enter to run when the Monaco editor has focus (use ref)
  React.useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      const isRun = (e.ctrlKey || e.metaKey) && e.key === 'Enter';
      if (!isRun) return;
      const hasFocus = !!editorRef.current && editorRef.current.hasTextFocus?.();
      if (!hasFocus) return;
      e.preventDefault();
      const fn = runCbRef.current;
      if (fn) await fn();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSaveFile = async () => {
  // Guard: need an open file path
    if (!filePath) {
      alert('Please open or create a file first before saving.');
      return;
    }

    // Get the current value from the Monaco Editor
    const currentCode = editorRef.current ? editorRef.current.getValue() : code;

    setIsSaving(true);

    try {
  // Persist to backend
      await apiService.saveCodeFile(username, filePath, currentCode);
      
  // Mirror saved state locally
      setInternalSavedContent(currentCode);
      setHasUnsavedChanges(false);
      
  // Parent callback
  onSaveFile(filename || filePath.split('/').pop() || '', currentCode);
      
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err.message;
      if (err?.response?.status === 403 && /Quota exceeded/i.test(detail)) {
        // Extract quota bytes if present
        const match = detail.match(/Limit (\d+) bytes/);
        const limit = match ? parseInt(match[1], 10) : undefined;
        onQuotaExceeded?.({ limitBytes: limit || 0, filePath: filePath });
        pushNotice?.({
          type: 'error',
          title: 'Storage Quota Exceeded',
          message: 'Saving failed because it would exceed your storage quota.' + (limit ? ` Limit: ${(limit/1024/1024).toFixed(1)} MB.` : ''),
          actionLabel: 'View Usage',
          onAction: () => onQuotaExceeded?.({ limitBytes: limit || 0, filePath: filePath })
        });
      } else {
        pushNotice?.({ type: 'error', title: 'Save Failed', message: detail || 'Unknown error' });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const isPythonFile = React.useMemo(() => {
    if (!filePath) return false;
    return /\.py$/i.test(filePath.trim());
  }, [filePath]);
  const isCFile = React.useMemo(() => {
    if (!filePath) return false;
    return /\.c$/i.test(filePath.trim());
  }, [filePath]);
  const isCppFile = React.useMemo(() => {
    if (!filePath) return false;
    return /\.(cpp|cc|cxx)$/i.test(filePath.trim());
  }, [filePath]);
  const isRunnable = isPythonFile || isCFile || isCppFile;
  const displayFileName = React.useMemo(() => {
    return filename || (filePath ? filePath.split('/').pop() || 'current file' : 'current file');
  }, [filename, filePath]);

  const actuallyRun = () => {
    const norm = (filePath || '').replace(/\\/g, '/');
    const srcAbs = `/app/${norm}`;
    const parts = norm.split('/');
    const base = parts.pop() || '';
    const dir = parts.join('/');
    const stem = base.replace(/\.[^.]+$/, '');
    const outAbs = dir ? `/app/${dir}/${stem}` : `/app/${stem}`;
    if (isPythonFile) {
      onExecuteCommand(`python "${srcAbs}"`);
    } else if (isCFile) {
      onExecuteCommand(`gcc -O2 -std=c11 "${srcAbs}" -o "${outAbs}" && "${outAbs}"`);
    } else if (isCppFile) {
      onExecuteCommand(`g++ -O2 -std=c++17 "${srcAbs}" -o "${outAbs}" && "${outAbs}"`);
    }
  };

  const handleRunCode = async () => {
  // Guards before run
    if (!filePath) {
      alert('Please open or create a file first before running code.');
      return;
    }

    if (!isRunnable) {
      alert('Run is available for Python (.py), C (.c), and C++ (.cpp/.cc/.cxx) files.');
      return;
    }

    // If unsaved changes, prompt user
    if (hasUnsavedChanges) {
      setRunConfirmOpen(true);
      return;
    }

    try {
      actuallyRun();
    } catch (err: any) {
      alert(`Error running code: ${err.message}`);
    }
  };

  // Keep refs pointing at the latest handlers to avoid stale captures in Monaco keybindings
  React.useEffect(() => {
    saveCbRef.current = handleSaveFile;
    runCbRef.current = handleRunCode;
  });


  const handleClearCode = () => {
    if (!isFileOpen) {
      alert('Please open a file first before clearing code.');
      return;
    }
    setCode('');
    if (editorRef.current) {
      editorRef.current.focus();
    }
  };

  return (
    <div className="code-editor-container">
      <div className="editor-header">
        <h3>
          {isFileOpen ? (
            <>
              <span className="editor-filename-with-icon">
                <FileIcon fileName={filename || ''} size={16} />
                <span title={filename}>{filename}</span>
              </span>
              {hasUnsavedChanges && <span className="unsaved-indicator">●</span>}
            </>
          ) : (
            '📄 No file open'
          )}
        </h3>
        <div className="editor-controls">
          <button onClick={handleClearCode} className="clear-btn" disabled={isSaving || !isFileOpen}>
            Clear
          </button>
          <button 
            onClick={handleSaveFile} 
            className={`save-btn ${hasUnsavedChanges ? 'has-changes' : ''}`}
            disabled={isSaving || !isFileOpen}
            title={hasUnsavedChanges ? 'Save unsaved changes' : 'No changes to save'}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={handleRunCode} className="run-btn" disabled={isSaving || !isFileOpen || !isRunnable}
            title={!isFileOpen ? 'Open a file to run' : !isRunnable ? 'Supported: Python (.py), C (.c), C++ (.cpp/.cc/.cxx)' : 'Run current file (Ctrl+Enter)'}>
            Run
          </button>
        </div>
      </div>

      <div className="editor-wrapper">
        {!isFileOpen && (
          <div className="file-status-indicator">
            📄 No file open - Create or select a file to start coding
          </div>
        )}
        <Editor
          height="500px"
          defaultLanguage="python"
          value={displayContent}
          onChange={(value) => {
            if (!isFileOpen) return;
            const v = value || '';
            setCode(v);
            // Mark unsaved immediately on user input
            const hasChangesNow = v !== internalSavedContent;
            setHasUnsavedChanges(hasChangesNow);
            onContentChange?.(hasChangesNow, v);
          }}
          onMount={handleEditorDidMount}
          theme="vs-dark"
          options={{
            fontSize: 14,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            insertSpaces: true,
            wordWrap: 'on',
            lineNumbers: 'on',
            folding: true,
            cursorBlinking: 'blink',
            contextmenu: true,
            mouseWheelZoom: true,
            readOnly: !isFileOpen,
          }}
        />
      </div>

      {/* Run confirmation when unsaved changes exist */}
      <ConfirmDialog
        open={runConfirmOpen}
        title="Unsaved Changes"
        message={`You have unsaved changes in "${displayFileName}". Save before running to ensure your latest edits are executed.`}
        cancelText="Cancel"
        secondaryText="Run Without Saving"
        confirmText="Save and Run"
        onCancel={() => setRunConfirmOpen(false)}
        onSecondary={() => {
          setRunConfirmOpen(false);
          try { actuallyRun(); } catch { /* noop */ }
        }}
        onConfirm={async () => {
          setRunConfirmOpen(false);
          await handleSaveFile();
          try { actuallyRun(); } catch { /* noop */ }
        }}
      />
    </div>
  );
};

export default CodeEditor;
