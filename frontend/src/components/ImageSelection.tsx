// ImageSelection: choose base container image then start workspace.
import React, { useEffect, useState, useCallback } from 'react';
import { apiService } from '../services/api';
import './ImageSelection.css';

interface ImageInfo {
  tag: string;
  id: string;
  size?: number;
  labels?: Record<string,string>;
  description?: string | null;
}

interface ImageSelectionProps {
  username: string;
  onImageChosen: (info: { image: string; containerID: string }) => void;
  onBack?: () => void; // In case we allow going back to login later
}

const formatSize = (bytes?: number) => {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB','MB','GB','TB'];
  let i = -1;
  let value = bytes;
  do { value /= 1024; i++; } while (value >= 1024 && i < units.length - 1);
  return value.toFixed(1) + ' ' + units[i];
};

const ImageSelection: React.FC<ImageSelectionProps> = ({ username, onImageChosen, onBack }) => {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<boolean>(false);
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>('');
  // Clean, minimal redesign: no sorting, no layout toggle. Only search + refresh + proceed.

  const loadImages = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
  const resp = await apiService.listImages();
  setImages(resp.images || []);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || 'Failed to load images');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadImages(); }, [loadImages]);

  const startWithImage = async (image: string) => {
    setStarting(true);
    setError('');
    try {
      const resp = await apiService.startContainer(username, image);
      onImageChosen({ image, containerID: resp.container_id });
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || 'Failed to start container');
    } finally {
      setStarting(false);
    }
  };

  const filtered = images.filter(img => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    const title = img.labels?.['org.opencontainers.image.title'] || img.labels?.['org.label-schema.name'] || '';
    return (
      img.tag.toLowerCase().includes(q) ||
      title.toLowerCase().includes(q) ||
      (img.description?.toLowerCase().includes(q))
    );
  });

  return (
    <div className="image-select-wrapper">
      <div className="image-select-header minimal">
        <h2 className="title">Choose Image</h2>
        <div className="controls">
          <input
            type="text"
            placeholder="Search..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="search-box"
            disabled={loading}
            aria-label="Search images"
          />
          <button onClick={loadImages} disabled={loading} className="icon-btn" title="Refresh images" aria-label="Refresh images">↻</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <div className="loading-area" aria-busy="true">Loading images...</div>
      ) : (
        <>
          <div className="image-grid new-grid" aria-label="Available images">
            {filtered.length === 0 && <div className="empty">No images match your search.</div>}
            {filtered.map(img => {
              const tag = img.tag;
              const title = img.labels?.['org.opencontainers.image.title'] || img.labels?.['org.label-schema.name'] || tag;
              let desc = (img as any).description || '';
              if (!desc && img.labels) {
                // Attempt to synthesize a tiny description from common label fragments
                const ver = img.labels['org.opencontainers.image.version'] || img.labels['version'];
                if (title || ver) {
                  desc = `${title || 'Image'}${ver ? ' v' + ver : ''}`.trim();
                }
              }
              return (
                <button
                  key={img.id + tag}
                  type="button"
                  className={`image-card minimal-card ${selectedTag === tag ? 'selected' : ''}`}
                  onClick={() => setSelectedTag(tag)}
                  data-tag={tag}
                  aria-label={(title || tag) + (selectedTag === tag ? ' (selected)' : '')}
                >
                  <div className="radio-circle" aria-hidden="true"><div className="inner" /></div>
                  <div className="meta">
                    <div className="tag" title={title}>{title}</div>
                    {desc && <div className="desc" title={desc}>{desc}</div>}
                    <div className="facts">
                      {img.size !== undefined && <span className="fact" title="Approx. size">{formatSize(img.size)}</span>}
                      <span className="fact dim" title={img.id}>{img.id.substring(0,12)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="footer-bar">
            <div className="count">{filtered.length} / {images.length} images</div>
            <button
              className="proceed-btn main"
              disabled={!selectedTag || starting}
              onClick={() => selectedTag && startWithImage(selectedTag)}
              title={selectedTag ? `Start with ${selectedTag}` : 'Select an image'}
            >{starting ? 'Starting...' : selectedTag ? `Use ${selectedTag}` : 'Choose an image'}</button>
          </div>
        </>
      )}
    </div>
  );
};

export default ImageSelection;