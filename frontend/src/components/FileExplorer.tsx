// FileExplorer: recursive tree + inline create/rename/delete, upload/download, quota bar & quota meter.
// Keeps minimal transient state; derives persistent structure from server list + expansion flags.
import React, { useState, useEffect, useRef } from 'react';
import { apiService } from '../services/api';
import { 
  FileIcon, 
  FolderIcon, 
  NewFileIcon, 
  NewFolderIcon, 
  RefreshIcon, 
  RenameIcon,
  DeleteIcon,
  DownloadIcon,
  UploadIcon,
  ChevronRightIcon
} from './Icons';
import './FileExplorer.css';
import ConfirmDialog from './ConfirmDialog';

interface FileItem {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileItem[];
  isExpanded?: boolean;
}

interface FileExplorerProps {
  username: string;
  onFileSelect: (filePath: string, fileName: string) => void;
  onNewFile?: (filePath: string, fileName: string) => void;
  onFileDeleted?: (filePath: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string, newFileName: string, isFolder: boolean) => void;
  currentFilePath?: string;
  filesWithUnsavedChanges?: Set<string>;
  pushNotice?: (n: { type: 'info'|'success'|'error'|'warning'; title?: string; message: string; actionLabel?: string; onAction?: () => void }) => void;
}

const FileExplorer: React.FC<FileExplorerProps> = ({ 
  username, 
  onFileSelect, 
  onNewFile, 
  onFileDeleted, 
  onFileRenamed,
  currentFilePath, 
  filesWithUnsavedChanges = new Set(),
  pushNotice
}) => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [renamingItem, setRenamingItem] = useState<string | null>(null);
  const [creatingItem, setCreatingItem] = useState<{ parentPath: string; type: 'file' | 'folder' } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileItem | null;
    visible: boolean;
  }>({ x: 0, y: 0, item: null, visible: false });
  const [confirmState, setConfirmState] = useState<{ open: boolean; item: FileItem | null }>({ open: false, item: null });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const creatingItemRef = useRef(creatingItem);
  const createInFlightRef = useRef(false);
  // Quota usage state
  const [usage, setUsage] = useState<{ usedBytes: number; quotaBytes: number; percent: number } | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);

  // Initial load & quota fetch
  useEffect(() => {
    loadFiles();
    refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  // Reflect externally opened file selection
  useEffect(() => {
    if (currentFilePath) {
      setSelectedFile(currentFilePath);
    }
  }, [currentFilePath]);

  const sortItems = (items: FileItem[]): FileItem[] => {
    const byName = (a: FileItem, b: FileItem) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const folders = items.filter(i => i.type === 'folder').sort(byName);
    const filesOnly = items.filter(i => i.type === 'file').sort(byName);
    return [...folders, ...filesOnly];
  };

  const sortTree = (items: FileItem[]): FileItem[] => {
    return sortItems(items).map(it => ({
      ...it,
      children: it.children ? sortTree(it.children) : it.children,
    }));
  };

  const loadFiles = async (targetPath?: string, detectRemovedCurrent: boolean = true) => {
    try {
  // Preserve expansion state
      const expandedPaths = getExpandedPaths(files);
      
      const response = await apiService.listFiles(username);
      
  // Reapply expansion & optionally open target path
      const filesWithExpandedStates = applyExpandedStates(sortTree(response.files), expandedPaths, targetPath);
      setFiles(filesWithExpandedStates);

  // Detect externally removed open file (e.g. deleted via terminal)
      if (detectRemovedCurrent && currentFilePath) {
        const existsInTree = (items: FileItem[], target: string): boolean => {
          for (const it of items) {
            if (it.path === target) return true;
            if (it.children && existsInTree(it.children, target)) return true;
          }
          return false;
        };
        if (!existsInTree(filesWithExpandedStates, currentFilePath)) {
          // Clear selection highlighting if it points to the missing file
          setSelectedFile(prev => (prev === currentFilePath ? '' : prev));
          // Notify parent to close the editor and purge caches for the missing file
          if (onFileDeleted) onFileDeleted(currentFilePath);
        }
      }
    } catch (error) {
      console.error('Error loading files:', error);
      setFiles([]);
    }
  };

  const refreshUsage = async () => {
    try {
      setUsageBusy(true);
      setUsageError(null);
      const data = await apiService.quotaUsage(username);
      const percent = data.quota_bytes > 0 ? Math.min(100, (data.used_bytes / data.quota_bytes) * 100) : 0;
      setUsage({ usedBytes: data.used_bytes, quotaBytes: data.quota_bytes, percent });
    } catch (e: any) {
      console.error('Failed to fetch quota usage', e);
      setUsageError(e?.response?.data?.detail || e.message || 'Failed to load usage');
    } finally {
      setUsageBusy(false);
    }
  };

  // Position context menu element after mount
  useEffect(() => {
    if (contextMenuRef.current && contextMenu.visible) {
      contextMenuRef.current.style.left = `${contextMenu.x}px`;
      contextMenuRef.current.style.top = `${contextMenu.y}px`;
    }
  }, [contextMenu]);

  const toggleFolder = (path: string) => {
    const updateFiles = (items: FileItem[]): FileItem[] => {
      return items.map(item => {
        if (item.path === path && item.type === 'folder') {
          return { ...item, isExpanded: !item.isExpanded };
        }
        if (item.children) {
          return { ...item, children: updateFiles(item.children) };
        }
        return item;
      });
    };
    setFiles(updateFiles(files));
  };

  // Gather expanded folder paths
  const getExpandedPaths = (items: FileItem[]): string[] => {
    const expandedPaths: string[] = [];
    const traverse = (fileItems: FileItem[]) => {
      fileItems.forEach(item => {
        if (item.type === 'folder' && item.isExpanded) {
          expandedPaths.push(item.path);
          if (item.children) {
            traverse(item.children);
          }
        }
      });
    };
    traverse(items);
    return expandedPaths;
  };

  // Restore expanded state & ensure target ancestors expanded
  const applyExpandedStates = (items: FileItem[], expandedPaths: string[], targetPath?: string): FileItem[] => {
    return items.map(item => {
      const isInExpandedPaths = expandedPaths.includes(item.path);
      const isTargetOrParent = targetPath ? 
        (item.path === targetPath || (targetPath.startsWith(item.path + '/') && item.path !== '')) : 
        false;
      const shouldBeExpanded = isInExpandedPaths || isTargetOrParent;
      
      const updatedItem: FileItem = {
        ...item,
        isExpanded: item.type === 'folder' ? shouldBeExpanded : undefined
      };

      if (updatedItem.children) {
        updatedItem.children = applyExpandedStates(updatedItem.children, expandedPaths, targetPath);
      }

      return updatedItem;
    });
  };

  // Parent directory of a given file path
  const getParentDirectory = (filePath: string): string => {
    const lastSlashIndex = filePath.lastIndexOf('/');
    if (lastSlashIndex === -1) {
      return ''; // File is in root directory
    }
    return filePath.substring(0, lastSlashIndex);
  };

  // Find an item by path in the current tree
  const findItemInTree = (items: FileItem[], target: string): FileItem | null => {
    for (const it of items) {
      if (it.path === target) return it;
      if (it.children) {
        const found = findItemInTree(it.children, target);
        if (found) return found;
      }
    }
    return null;
  };

  const handleFileClick = (item: FileItem) => {
    if (item.type === 'folder') {
      toggleFolder(item.path);
  setSelectedFolder(item.path);
  setSelectedFile(item.path);
    } else {
      setSelectedFile(item.path);
  // Track parent folder when file selected
      const parentDir = getParentDirectory(item.path);
      setSelectedFolder(parentDir);
      onFileSelect(item.path, item.name);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      item,
      visible: true
    });
  };

  const hideContextMenu = () => {
    setContextMenu({ x: 0, y: 0, item: null, visible: false });
  };

  const handleNewItem = (type: 'file' | 'folder', parentPath: string = '') => {
    createInFlightRef.current = false;
    // Start inline create flow
    // If parentPath no longer exists (e.g., was deleted), fallback to root
    const existsFolder = (items: FileItem[], target: string): boolean => {
      for (const it of items) {
        if (it.type === 'folder') {
          if (it.path === target) return true;
          if (it.children && existsFolder(it.children, target)) return true;
        }
      }
      return false;
    };
    const safeParent = parentPath && existsFolder(files, parentPath) ? parentPath : '';
    ensurePathExpanded(safeParent);
    setCreatingItem({ parentPath: safeParent, type });
    hideContextMenu();
  };

  const cancelCreate = () => {
    createInFlightRef.current = false;
    setCreatingItem(null);
  };

  const completeCreate = async (name: string) => {
    const creating = creatingItem;
    if (!creating) return;
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    const trimmed = (name || '').trim().replace(/\\/g, '/');
    if (!trimmed) {
      cancelCreate();
      return;
    }
    if (trimmed.includes('/')) {
      alert('Name must not contain "/". To create in a subfolder, first select that folder and then create the item.');
      cancelCreate();
      return;
    }
    try {
      const fullPath = creating.parentPath ? `${creating.parentPath}/${trimmed}` : trimmed;
  await apiService.createFile(username, fullPath, creating.type);
  // Creating a file/folder may affect usage (file definitely, folder negligible but safe)
  refreshUsage();

      // Reload files and ensure the new item (for folders) or parent (for files) is expanded
      await loadFiles(creating.type === 'folder' ? fullPath : creating.parentPath);

      // Selection behavior: select/open files; select and expand folders
      if (creating.type === 'file') {
        if (onNewFile) {
          onNewFile(fullPath, trimmed);
        }
        setSelectedFile(fullPath);
        setSelectedFolder(creating.parentPath);
      } else {
        setSelectedFolder(fullPath);
        setSelectedFile(fullPath);
      }
    } catch (error: any) {
      const detail = error?.response?.data?.detail || error.message || error;
      pushNotice?.({ type: 'error', title: 'Create Failed', message: detail });
    } finally {
      setCreatingItem(null);
      createInFlightRef.current = false;
    }
  };

  useEffect(() => {
    creatingItemRef.current = creatingItem;
    if (!creatingItem) {
      createInFlightRef.current = false;
    }
  }, [creatingItem]);

  const handleCreateBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (!creatingItemRef.current) {
      cancelCreate();
      return;
    }
    const value = event.target.value;
    if (value.trim()) {
      completeCreate(value);
    } else {
      cancelCreate();
    }
  };

  // Ensure a path (and ancestors) are expanded
  const ensurePathExpanded = (targetPath: string) => {
    if (!targetPath) return; // root
    const expandAncestors = (items: FileItem[]): FileItem[] => {
      return items.map((it) => {
        if (it.type === 'folder') {
          const shouldExpand = targetPath === it.path || targetPath.startsWith(it.path + '/');
          const nextChildren = it.children ? expandAncestors(it.children) : it.children;
          return {
            ...it,
            isExpanded: shouldExpand ? true : it.isExpanded,
            children: nextChildren,
          };
        }
        return it;
      });
    };
    setFiles(prev => expandAncestors(prev));
  };

  // Begin inline rename
  const startRename = (item: FileItem) => {
    setRenamingItem(item.path);
    hideContextMenu();
  };

  // Cancel rename
  const cancelRename = () => {
    setRenamingItem(null);
  };

  // Complete rename
  const completeRename = async (item: FileItem, newName: string) => {
    if (!newName || newName === item.name) {
      setRenamingItem(null);
      return;
    }

    try {
  // Build new path
      const pathParts = item.path.split('/');
      pathParts[pathParts.length - 1] = newName;
      const newPath = pathParts.join('/');

  // Backend rename
  await apiService.renameFile(username, item.path, newPath);

  // Inform parent
      if (onFileRenamed) {
        onFileRenamed(item.path, newPath, newName, item.type === 'folder');
      }

  // Refresh tree preserving parent expansion
  const parentDir = getParentDirectory(newPath);
  await loadFiles(parentDir, false);

      setRenamingItem(null);
    } catch (error: any) {
      console.error('Error renaming:', error);
      pushNotice?.({ type: 'error', title: 'Rename Failed', message: error?.response?.data?.detail || error.message || error });
      setRenamingItem(null);
    }
  };

  const handleDelete = (item: FileItem) => {
    setConfirmState({ open: true, item });
    hideContextMenu();
  };

  const confirmDelete = async () => {
    const item = confirmState.item;
    if (!item) {
      setConfirmState({ open: false, item: null });
      return;
    }
    try {
  await apiService.deleteFile(username, item.path);
  await loadFiles(undefined, false);
  refreshUsage();

      if (onFileDeleted) {
        onFileDeleted(item.path);
      }
      // Reset selection if it points to the deleted item or its descendants
      if (item.type === 'folder') {
        const deletedPath = item.path;
        if (selectedFolder && (selectedFolder === deletedPath || selectedFolder.startsWith(deletedPath + '/'))) {
          setSelectedFolder(getParentDirectory(deletedPath));
        }
        if (selectedFile && (selectedFile === deletedPath || selectedFile.startsWith(deletedPath + '/'))) {
          setSelectedFile('');
        }
        // Cancel any inline create under the deleted folder
        if (creatingItem && (creatingItem.parentPath === deletedPath || creatingItem.parentPath.startsWith(deletedPath + '/'))) {
          setCreatingItem(null);
        }
      } else {
        if (selectedFile === item.path) setSelectedFile('');
      }
    } catch (error: any) {
      console.error('Error deleting:', error);
      pushNotice?.({ type: 'error', title: 'Delete Failed', message: error?.response?.data?.detail || error.message || error });
    } finally {
      setConfirmState({ open: false, item: null });
    }
  };

  const cancelDelete = () => setConfirmState({ open: false, item: null });

  const handleUpload = () => {
    fileInputRef.current?.click();
    hideContextMenu();
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      try {
        // Use selected folder as target path, or root if no folder selected
        const targetPath = selectedFolder || '/';
  await apiService.uploadFiles(username, files, targetPath);
  // Reload files and ensure the target directory is expanded
  await loadFiles(selectedFolder, false);
  refreshUsage();
        // Success notification optional
        pushNotice?.({ type: 'success', title: 'Upload Complete', message: `${files.length} file(s) uploaded.` });
      } catch (error: any) {
        console.error('Error uploading files:', error);
        const detail = error?.response?.data?.detail || error.message || error;
        if (error?.response?.status === 403 && /Quota exceeded/i.test(detail)) {
          pushNotice?.({
            type: 'error',
            title: 'Quota Exceeded',
            message: 'Upload would exceed your storage quota.'
          });
        } else {
          pushNotice?.({ type: 'error', title: 'Upload Failed', message: detail });
        }
      }
    }
    // Always clear value so selecting the same file again triggers onChange
    event.target.value = '';
  };

  const handleDownload = async (item: FileItem) => {
    try {
      await apiService.downloadFile(username, item.path);
    } catch (error) {
      console.error('Error downloading:', error);
      alert(`Error downloading: ${error}`);
    }
    hideContextMenu();
  };

  const handleHeaderDownload = async () => {
    // Determine if current selection is a file or a folder; if none, download whole workspace
    const selectedPath = selectedFile || selectedFolder;
    if (!selectedPath) {
      try {
        await apiService.downloadFolder(username, '');
      } catch (error) {
        console.error('Error downloading workspace:', error);
        alert(`Error downloading workspace: ${error}`);
      }
      return;
    }

    // Find the selected item type by traversing current files
    const findItem = (items: FileItem[], target: string): FileItem | null => {
      for (const it of items) {
        if (it.path === target) return it;
        if (it.children) {
          const found = findItem(it.children, target);
          if (found) return found;
        }
      }
      return null;
    };

    const item = findItem(files, selectedPath);
    if (!item) return;

    try {
      if (item.type === 'folder') {
        await apiService.downloadFolder(username, item.path);
      } else {
        await apiService.downloadFile(username, item.path);
      }
    } catch (error: any) {
      console.error('Error downloading:', error);
      pushNotice?.({ type: 'error', title: 'Download Failed', message: error?.response?.data?.detail || error.message || error });
    }
  };

  const renderFileTree = (items: FileItem[], level: number = 0): React.ReactNode => {
    return items.map((item) => (
      <div key={item.path} className="file-tree-item">
        <div
          className={`file-item ${selectedFile === item.path ? 'selected' : ''}`}
          data-depth={level}
          onClick={() => { handleFileClick(item); containerRef.current?.focus(); }}
          onContextMenu={(e) => handleContextMenu(e, item)}
        >
          {item.type === 'folder' ? (
            <button
              className={`folder-toggle ${item.isExpanded ? 'expanded' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(item.path);
              }}
              title={item.isExpanded ? 'Collapse folder' : 'Expand folder'}
            >
              <ChevronRightIcon />
            </button>
          ) : (
            <div className="folder-toggle folder-toggle-hidden" />
          )}
          <div className="file-icon">
            {item.type === 'folder' ? (
              <FolderIcon isOpen={item.isExpanded || false} />
            ) : (
              <FileIcon fileName={item.name} />
            )}
          </div>
          {renamingItem === item.path ? (
            <input
              type="text"
              defaultValue={item.name}
              className="rename-input"
              autoFocus
              aria-label={`Rename ${item.name}`}
              onBlur={() => cancelRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const newName = (e.target as HTMLInputElement).value.trim();
                  completeRename(item, newName);
                } else if (e.key === 'Escape') {
                  cancelRename();
                }
              }}
              onFocus={(e) => {
                // Select filename without extension for files
                if (item.type === 'file' && item.name.includes('.')) {
                  const lastDotIndex = item.name.lastIndexOf('.');
                  e.target.setSelectionRange(0, lastDotIndex);
                } else {
                  e.target.select();
                }
              }}
            />
          ) : (
            <span className="file-name">{item.name}</span>
          )}
          {item.type === 'file' && filesWithUnsavedChanges.has(item.path) && (
            <span className="file-unsaved-indicator" title="File has unsaved changes">●</span>
          )}
        </div>
        {item.type === 'folder' && item.isExpanded && (
          <div className="folder-children">
            {item.children && renderFileTree(item.children, level + 1)}
            {creatingItem && creatingItem.parentPath === item.path && (
              <div className="file-tree-item">
                <div className="file-item" data-depth={level + 1}>
                  <div className="folder-toggle folder-toggle-hidden" />
                  <div className="file-icon">
                    {creatingItem.type === 'folder' ? (
                      <FolderIcon isOpen={true} />
                    ) : (
                      <FileIcon fileName="" />
                    )}
                  </div>
                  <input
                    type="text"
                    className="rename-input"
                    autoFocus
                    aria-label={`Create ${creatingItem.type}`}
                    placeholder={`New ${creatingItem.type}`}
                    onBlur={handleCreateBlur}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const value = (e.target as HTMLInputElement).value;
                        completeCreate(value);
                      } else if (e.key === 'Escape') {
                        cancelCreate();
                      }
                    }}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    ));
  };

  // Keyboard handling for explorer (Delete key to delete selected item)
  const onExplorerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      // Avoid deleting while renaming/creating inline
      if (renamingItem || creatingItem) return;
      const selectedPath = selectedFile || selectedFolder;
      if (!selectedPath) return;
      const item = findItemInTree(files, selectedPath);
      if (!item) return;
      handleDelete(item);
    }
  };

  return (
    <div
      ref={containerRef}
      className="file-explorer"
      tabIndex={0}
      onKeyDown={onExplorerKeyDown}
      onClick={(e) => {
      hideContextMenu();
      // If clicking on empty space (not on a file/folder), select root directory
      const target = e.target as HTMLElement;
      const isEmptySpaceClick = target === e.currentTarget || 
                               target.classList.contains('file-tree') ||
                               target.classList.contains('file-explorer');
      
      if (isEmptySpaceClick) {
        setSelectedFolder(''); // Empty string represents root directory
        setSelectedFile('');   // Clear file selection for visual feedback
      }
      // Ensure explorer has focus so Delete key works
      containerRef.current?.focus();
    }}>
      <div className="file-explorer-header">
        <h3>EXPLORER</h3>
        <div className="file-explorer-actions">
          <button
            className="action-btn"
            onClick={() => handleNewItem('file', selectedFolder)}
            title={selectedFolder ? `New File in ${selectedFolder}` : "New File in workspace root"}
          >
            <NewFileIcon size={16} />
          </button>
          <button
            className="action-btn"
            onClick={() => handleNewItem('folder', selectedFolder)}
            title={selectedFolder ? `New Folder in ${selectedFolder}` : "New Folder in workspace root"}
          >
            <NewFolderIcon size={16} />
          </button>
          <button
            className="action-btn"
            onClick={() => { loadFiles(); refreshUsage(); }}
            title="Refresh Explorer"
          >
            <RefreshIcon size={16} />
          </button>
          <button
            className="action-btn"
            onClick={handleHeaderDownload}
            title={selectedFile || selectedFolder ? `Download ${selectedFile || selectedFolder}` : 'Download workspace (all files)'}
          >
            <DownloadIcon size={16} />
          </button>
          <button
            className="action-btn"
            onClick={handleUpload}
            title={selectedFolder ? `Upload Files to ${selectedFolder}` : "Upload Files to workspace root"}
          >
            <UploadIcon size={16} />
          </button>
        </div>
      </div>
      {/* Storage usage indicator */}
      {usage && (() => {
        const bucket = Math.round(usage.percent);
        return (
          <div className="fe-quota-container" title={usageError || 'Storage usage'} onClick={(e) => { e.stopPropagation(); }}>
            <div className={`fe-quota-bar ${usage.percent >= 98 ? 'critical' : usage.percent >= 90 ? 'high' : usage.percent >= 75 ? 'warn' : 'ok'}`}> 
              <div className={`fe-quota-bar-fill pct-${bucket}`} />
            </div>
            <div className="fe-quota-stats">
              <span>{(usage.usedBytes/1024/1024).toFixed(2)} MB</span>
              <span>/ {(usage.quotaBytes/1024/1024).toFixed(0)} MB ({usage.percent.toFixed(1)}%)</span>
            </div>
          </div>
        );
      })()}
      {!usage && usageBusy && (
        <div className="fe-quota-container" title="Loading usage...">
          <div className="fe-quota-bar ok">
            <div className="fe-quota-bar-fill pct-0" />
          </div>
          <div className="fe-quota-stats"><span>Loading...</span></div>
        </div>
      )}
      {!usage && !usageBusy && usageError && (
        <div className="fe-quota-container" title={usageError} onClick={(e) => { e.stopPropagation(); refreshUsage(); }}>
          <div className="fe-quota-bar warn">
            <div className="fe-quota-bar-fill pct-0" />
          </div>
            <div className="fe-quota-stats"><span>Error – click to retry</span></div>
        </div>
      )}
      
      <div className="file-tree" onClick={(e) => {
        // If clicking on empty space in file tree, reset to root
        const target = e.target as HTMLElement;
        if (target === e.currentTarget) {
          setSelectedFolder('');
          setSelectedFile('');
        }
      }}>
        {/* Empty state when there are no files/folders */}
        {files.length === 0 && !(creatingItem && creatingItem.parentPath === '') && (
          <div className="file-empty-state" onClick={(e) => e.stopPropagation()}>
            <p className="file-empty-title">No files yet</p>
            <p className="file-empty-subtitle">Create your first file or upload existing files.</p>
            <div className="file-empty-actions" role="group" aria-label="Empty workspace actions">
              <button
                className="empty-action"
                onClick={() => handleNewItem('file', '')}
                aria-label="Create"
                title="Create"
              >
                <div className="empty-action-icon" aria-hidden="true">
                  <NewFileIcon size={40} />
                </div>
                <span className="empty-action-label">Create</span>
              </button>
              <button
                className="empty-action"
                onClick={handleUpload}
                aria-label="Upload"
                title="Upload"
              >
                <div className="empty-action-icon" aria-hidden="true">
                  <UploadIcon size={40} />
                </div>
                <span className="empty-action-label">Upload</span>
              </button>
            </div>
          </div>
        )}
        {/* Inline create at root */}
        {creatingItem && creatingItem.parentPath === '' && (
          <div className="file-tree-item">
            <div className="file-item" data-depth={0}>
              <div className="folder-toggle folder-toggle-hidden" />
              <div className="file-icon">
                {creatingItem.type === 'folder' ? (
                  <FolderIcon isOpen={true} />
                ) : (
                  <FileIcon fileName="" />
                )}
              </div>
              <input
                type="text"
                className="rename-input"
                autoFocus
                aria-label={`Create ${creatingItem.type}`}
                placeholder={`New ${creatingItem.type}`}
                onBlur={handleCreateBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const value = (e.target as HTMLInputElement).value;
                    completeCreate(value);
                  } else if (e.key === 'Escape') {
                    cancelCreate();
                  }
                }}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          </div>
        )}
        {renderFileTree(files)}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && contextMenu.item && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => {
            const targetPath = contextMenu.item!.type === 'folder' ? contextMenu.item!.path : '';
            handleNewItem('file', targetPath);
          }}>
            <NewFileIcon size={16} />
            <span>New File</span>
          </div>
          <div className="context-menu-item" onClick={() => {
            const targetPath = contextMenu.item!.type === 'folder' ? contextMenu.item!.path : '';
            handleNewItem('folder', targetPath);
          }}>
            <NewFolderIcon size={16} />
            <span>New Folder</span>
          </div>
          <div className="context-menu-separator"></div>
          <div className="context-menu-item" onClick={() => startRename(contextMenu.item!)}>
            <RenameIcon size={16} />
            <span>Rename</span>
          </div>
          <div className="context-menu-item" onClick={() => handleDelete(contextMenu.item!)}>
            <DeleteIcon size={16} />
            <span>Delete</span>
          </div>
          <div className="context-menu-separator"></div>
          {contextMenu.item.type === 'file' && (
            <div className="context-menu-item" onClick={() => handleDownload(contextMenu.item!)}>
              <DownloadIcon size={16} />
              <span>Download</span>
            </div>
          )}
          {contextMenu.item.type === 'folder' && (
            <>
              <div className="context-menu-item" onClick={() => handleDownload(contextMenu.item!)}>
                <DownloadIcon size={16} />
                <span>Download Folder</span>
              </div>
              <div className="context-menu-item" onClick={handleUpload}>
                <UploadIcon size={16} />
                <span>Upload Files</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="file-input-hidden"
        aria-label="Upload files"
        onChange={handleFileUpload}
        onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmState.open}
        title="Delete item"
        message={confirmState.item ? `Are you sure you want to delete "${confirmState.item.name}"? This action cannot be undone.` : ''}
        confirmText="Delete"
        cancelText="Cancel"
        destructive
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
};

export default FileExplorer;