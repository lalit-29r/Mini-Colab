import axios from 'axios';

// Derive API/WS base dynamically to work on localhost and network links
const loc = window.location;
const isHttps = loc.protocol === 'https:';
const defaultHost = loc.hostname; // use the same host you open the app on
const defaultApiPort = process.env.REACT_APP_API_PORT || '8000';
const resolvedHost = (process.env.REACT_APP_API_HOST || defaultHost).toString();

// Allow full override via env (supports reverse proxy paths like '/api')
const API_BASE_URL = (process.env.REACT_APP_API_BASE_URL && process.env.REACT_APP_API_BASE_URL.trim().length > 0)
  ? process.env.REACT_APP_API_BASE_URL
  : `${isHttps ? 'https' : 'http'}://${resolvedHost}:${process.env.REACT_APP_API_PORT || defaultApiPort}`;

const WS_BASE_URL = (process.env.REACT_APP_WS_BASE_URL && process.env.REACT_APP_WS_BASE_URL.trim().length > 0)
  ? process.env.REACT_APP_WS_BASE_URL
  : `${isHttps ? 'wss' : 'ws'}://${resolvedHost}:${process.env.REACT_APP_API_PORT || defaultApiPort}`;

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000, // 30 seconds timeout for code execution
});

export interface LoginResponse {
  message: string;
  container_id: string;
}

export interface AuthResponse {
  message: string;
  username: string;
  has_container?: boolean;
  container_id?: string | null;
}

// Removed legacy RunCodeResponse (HTTP /run)

export interface LogoutResponse {
  message: string;
}

export interface WebSocketMessage {
  username?: string;
  input?: string;
}

export const apiService = {
  login: async (username: string): Promise<LoginResponse> => {
    const formData = new FormData();
    formData.append('username', username);
    
    const response = await api.post('/login', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  auth: async (username: string): Promise<AuthResponse> => {
    const formData = new FormData();
    formData.append('username', username);
    const response = await api.post('/auth', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data as AuthResponse;
  },

  listImages: async (): Promise<{ images: Array<{ tag: string; id: string; size?: number; description?: string | null; labels?: Record<string,string> }> }> => {
    const response = await api.get('/images');
    return response.data;
  },

  startContainer: async (username: string, image: string): Promise<{ message: string; container_id: string; image: string }> => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('image', image);
    const response = await api.post('/start-container', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  // Legacy HTTP /run is not used; execution happens via container terminal.

  // Save code to a file in the user's container directory
  saveCodeFile: async (username: string, filename: string, code: string): Promise<{message: string}> => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('filename', filename);
    formData.append('code', code);
    
    const response = await api.post('/save-file', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  // WebSocket for direct run (/ws/run) is not used; terminal WebSocket is used instead.

  sendToWebSocket: (ws: WebSocket, message: WebSocketMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  },

  // Create WebSocket for terminal connection
  createTerminalWebSocket: (onMessage: (data: string) => void, onClose?: () => void): WebSocket => {
    const ws = new WebSocket(`${WS_BASE_URL}/ws/terminal`);
    
    ws.onmessage = (event) => {
      onMessage(event.data);
    };
    
    ws.onclose = () => {
      if (onClose) onClose();
    };
    
    ws.onerror = (error) => {
      console.error('Terminal WebSocket error:', error);
      onMessage('Terminal connection error');
    };
    
    return ws;
  },

  logout: async (username: string): Promise<LogoutResponse> => {
    const formData = new FormData();
    formData.append('username', username);
    
    const response = await api.post('/logout', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  // File system operations
  listFiles: async (username: string) => {
    const response = await api.get(`/files/${username}`);
    return response.data;
  },

  createFile: async (username: string, filepath: string, fileType: 'file' | 'folder') => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('filepath', filepath);
    formData.append('file_type', fileType);
    
    const response = await api.post('/create-file', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  renameFile: async (username: string, oldPath: string, newPath: string) => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('old_path', oldPath);
    formData.append('new_path', newPath);
    
    const response = await api.post('/rename-file', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  deleteFile: async (username: string, filepath: string) => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('filepath', filepath);
    
    const response = await api.post('/delete-file', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  uploadFiles: async (username: string, files: FileList, targetPath: string = '/') => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('target_path', targetPath);
    
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    
    const response = await api.post('/upload-files', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    return response.data;
  },

  downloadFile: async (username: string, filepath: string) => {
    const response = await api.get(`/download-file/${username}`, {
      params: { filepath },
      responseType: 'blob',
    });
    
    // Create download link
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.download = filepath.split('/').pop() || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    
    return { message: 'File downloaded successfully' };
  },

  downloadFolder: async (username: string, folderpath: string) => {
    const response = await api.get(`/download-folder/${username}`, {
      params: { folderpath },
      responseType: 'blob',
    });

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    // Prefer server-provided filename from Content-Disposition
    const disposition = (response.headers as any)['content-disposition'] as string | undefined;
    let filename = '';
    if (disposition) {
      const match = disposition.match(/filename="?([^";]+)"?/i);
      if (match && match[1]) {
        filename = match[1];
      }
    }
    if (!filename) {
      const name = folderpath.split('/').pop() || 'workspace';
      filename = `${name}.zip`;
    }
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);

    return { message: 'Folder downloaded successfully' };
  },

  quotaUsage: async (username: string): Promise<{ username: string; used_bytes: number; quota_bytes: number; percent_used: number }> => {
    const response = await api.get(`/quota-usage/${username}`);
    return response.data;
  },

  readFile: async (username: string, filepath: string) => {
    const response = await api.get(`/read-file/${username}`, {
      params: { filepath },
    });
    
    return response.data;
  },

  // ----- Admin APIs -----
  adminLogin: async (password: string): Promise<{ token: string; ttl_seconds: number }> => {
    const formData = new FormData();
    formData.append('password', password);
    const response = await api.post('/admin/login', formData);
    return response.data;
  },
  adminStats: async (token: string): Promise<{ overall: any; users: any[] }> => {
    const response = await api.get('/admin/stats', { headers: { 'x-admin-token': token } });
    return response.data;
  },
  adminStopUser: async (token: string, username: string): Promise<{ message: string }> => {
    const formData = new FormData();
    formData.append('username', username);
    const response = await api.post('/admin/stop-user', formData, { headers: { 'x-admin-token': token } });
    return response.data;
  },
  adminSetQuota: async (token: string, username: string, quotaMB: number): Promise<{ message: string; quota_bytes: number }> => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('quota_mb', String(quotaMB));
    const response = await api.post('/admin/set-quota', formData, { headers: { 'x-admin-token': token } });
    return response.data;
  },
  adminListUsers: async (token: string): Promise<{ users: Array<{ username: string; container_id: string; created_at: string }> }> => {
    const response = await api.get('/admin/list-users', { headers: { 'x-admin-token': token } });
    return response.data;
  },
  // Job management
  adminListJobs: async (token: string, username: string): Promise<{ username: string; shell_pid: number | null; jobs: Array<{ pid: number; command: string; cpu_percent: number; mem_percent: number; elapsed_seconds: number }> }> => {
    const response = await api.get('/admin/jobs', { headers: { 'x-admin-token': token }, params: { username } });
    return response.data;
  },
  adminKillJob: async (token: string, username: string, pid: number, signalName: string = 'TERM'): Promise<{ message: string; pid: number; signal: string }> => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('pid', String(pid));
    formData.append('signal_name', signalName);
    const response = await api.post('/admin/kill-job', formData, { headers: { 'x-admin-token': token } });
    return response.data;
  },
  adminChangePassword: async (token: string, currentPassword: string, newPassword: string): Promise<{ message: string }> => {
    const formData = new FormData();
    formData.append('current_password', currentPassword);
    formData.append('new_password', newPassword);
    const response = await api.post('/admin/change-password', formData, { headers: { 'x-admin-token': token } });
    return response.data;
  },
};

export default apiService;
