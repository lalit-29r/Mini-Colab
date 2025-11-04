// Icons: central set of small UI icons & file/folder glyph helpers.
import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

// File type icons matching VS Code
type FileMeta = { color: string; label?: string; secondary?: string };

const filePalette: Record<string, FileMeta> = {
  // Languages
  py: { color: '#3572A5', label: 'PY' },
  js: { color: '#f1e05a', label: 'JS', secondary: '#000' },
  ts: { color: '#2b7489', label: 'TS' },
  jsx: { color: '#61dafb', label: 'JSX', secondary: '#000' },
  tsx: { color: '#3178c6', label: 'TSX' },
  c: { color: '#555555', label: 'C' },
  h: { color: '#a074c4', label: 'H' },
  cpp: { color: '#00599C', label: 'C++' },
  hpp: { color: '#a074c4', label: 'H++' },
  java: { color: '#b07219', label: 'JAVA' },
  cs: { color: '#178600', label: 'C#' },
  go: { color: '#00ADD8', label: 'GO' },
  rs: { color: '#dea584', label: 'RS' },
  php: { color: '#4F5D95', label: 'PHP' },
  rb: { color: '#701516', label: 'RB' },
  sh: { color: '#89e051', label: 'SH', secondary: '#000' },
  ps1: { color: '#012456', label: 'PS', secondary: '#fff' },
  bat: { color: '#6e6e6e', label: 'BAT' },

  // Web
  html: { color: '#e34c26', label: 'HTML' },
  css: { color: '#563d7c', label: 'CSS' },
  scss: { color: '#c6538c', label: 'SCSS' },
  less: { color: '#1d365d', label: 'LESS' },

  // Data / text
  json: { color: '#f38b00', label: 'JSON' },
  yml: { color: '#cb171e', label: 'YML' },
  yaml: { color: '#cb171e', label: 'YAML' },
  md: { color: '#6e7781', label: 'MD' },
  csv: { color: '#2ea043', label: 'CSV' },
  txt: { color: '#8b949e', label: 'TXT' },
  log: { color: '#8b949e', label: 'LOG' },
  ipynb: { color: '#f37726', label: 'IPYNB' },

  // Assets
  svg: { color: '#ff4785', label: 'SVG' },
  png: { color: '#a371f7', label: 'IMG' },
  jpg: { color: '#a371f7', label: 'IMG' },
  jpeg: { color: '#a371f7', label: 'IMG' },
  gif: { color: '#a371f7', label: 'IMG' },
  pdf: { color: '#d73a49', label: 'PDF' },
};

const fileIconAsset: Record<string, string> = {
  py: '/icons/filetypes/python.svg',
  js: '/icons/filetypes/javascript.svg',
  mjs: '/icons/filetypes/javascript.svg',
  cjs: '/icons/filetypes/javascript.svg',
  ts: '/icons/filetypes/typescript.svg',
  tsx: '/icons/filetypes/typescript.svg',
  jsx: '/icons/filetypes/javascript.svg',
  c: '/icons/filetypes/c.svg',
  h: '/icons/filetypes/c.svg',
  cpp: '/icons/filetypes/cpp.svg',
  hpp: '/icons/filetypes/cpp.svg',
  json: '/icons/filetypes/json.svg',
  csv: '/icons/filetypes/csv.svg',
  txt: '/icons/filetypes/text.svg',
  log: '/icons/filetypes/text.svg',
};

export const FileIcon: React.FC<IconProps & { fileName: string }> = ({ fileName, size = 16, className = '', title }) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const asset = fileIconAsset[ext];
  if (asset) {
    return (
      <img src={asset} width={size} height={size} className={`vsc-file-icon ${className}`} alt={title || fileName} title={title || fileName} />
    );
  }
  // Fallbacks: use color badges for a few text/data types; else generic file
  const meta = filePalette[ext];
  if (meta) {
    const sizeClass = size !== 16 ? `vsc-icon--${size}` : 'vsc-icon';
    return <i className={`codicon codicon-file-code ${sizeClass} ${className}`} title={title || fileName} />;
  }
  const sizeClass = size !== 16 ? `vsc-icon--${size}` : 'vsc-icon';
  return <i className={`codicon codicon-file ${sizeClass} ${className}`} title={title || fileName} />;
};

// Folder icons
export const FolderIcon: React.FC<IconProps & { isOpen?: boolean }> = ({ isOpen = false, size = 16, className = '', title }) => (
  <i className={`codicon ${isOpen ? 'codicon-folder-opened' : 'codicon-folder'} ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || (isOpen ? 'Opened Folder' : 'Folder')} />
);

// Action icons for toolbar
export const NewFileIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-new-file ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'New File'} />
);

export const NewFolderIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-new-folder ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'New Folder'} />
);

export const RefreshIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-refresh ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Refresh'} />
);

export const CollapseIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-collapse-all ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Collapse'} />
);

// Context menu icons
export const RenameIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-edit ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Rename'} />
);

export const DeleteIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-trash ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Delete'} />
);

export const DownloadIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-cloud-download ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Download'} />
);

export const UploadIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-cloud-upload ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Upload'} />
);

// Chevron icons for tree expansion
export const ChevronRightIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-chevron-right ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Expand'} />
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 16, className = '', title }) => (
  <i className={`codicon codicon-chevron-down ${size !== 16 ? `vsc-icon--${size}` : 'vsc-icon'} ${className}`} title={title || 'Collapse'} />
);

const IconComponents = {
  FileIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  RefreshIcon,
  CollapseIcon,
  RenameIcon,
  DeleteIcon,
  DownloadIcon,
  UploadIcon,
  ChevronRightIcon,
  ChevronDownIcon,
};

export default IconComponents;