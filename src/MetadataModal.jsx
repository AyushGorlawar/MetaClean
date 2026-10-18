import React, { useState, useEffect, useMemo } from 'react';
import {
  X, Bot, Sparkles, Copy, Check, Camera, MapPin, ShieldCheck,
  Sliders, Search, ExternalLink, Calendar, Zap, AlertTriangle,
  Download, ArrowRight, ShieldAlert, Cpu
} from 'lucide-react';

function humanKey(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function MetadataModal({ item, onClose, onClean, isProcessing }) {
  const [activeTab, setActiveTab] = useState(() => {
    if (item?.before?.analysis?.isAi) return 'ai';
    if (item?.before?.analysis?.camera?.isCamera || item?.before?.analysis?.privacy?.hasGps) return 'camera';
    return 'all';
  });
  const [search, setSearch] = useState('');
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedNeg, setCopiedNeg] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => {
    if (item?.kind === 'image' && item?.file) {
      const url = URL.createObjectURL(item.file);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setPreviewUrl(null);
  }, [item?.id]);

  if (!item) return null;

  const analysis = item.before?.analysis || {};
  const ai = analysis.ai || {};
  const camera = analysis.camera || {};
  const privacy = analysis.privacy || {};
  const allFields = analysis.allFields || item.before?.fields || {};

  const handleCopy = (text, type) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    if (type === 'prompt') {
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } else if (type === 'neg') {
      setCopiedNeg(true);
      setTimeout(() => setCopiedNeg(false), 2000);
    } else if (type === 'all') {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    }
  };

  const filteredFields = useMemo(() => {
    const entries = Object.entries(allFields);
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
  }, [allFields, search]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <header className="modal-header">
          <div className="modal-header-main">
            {previewUrl ? (
              <img src={previewUrl} alt={item.file.name} className="modal-thumb" />
            ) : (
              <div className="modal-icon-ph"><Sparkles size={22} /></div>
            )}
            <div className="modal-title-area">
              <div className="modal-tags">
                {analysis.isAi && (
                  <span className="origin-pill ai">
                    <Bot size={13} /> {ai.generator || 'AI Generated'}
                  </span>
                )}
                {privacy.hasGps && (
                  <span className="origin-pill warning">
                    <MapPin size={13} /> GPS Location
                  </span>
                )}
                {camera.isCamera && !analysis.isAi && (
                  <span className="origin-pill camera">
                    <Camera size={13} /> {camera.make} {camera.model}
                  </span>
                )}
                {Object.keys(allFields).length === 0 && (
                  <span className="origin-pill clean">
                    <ShieldCheck size={13} /> Clean / No Metadata
                  </span>
                )}
              </div>
              <h2 title={item.file.name}>{item.file.name}</h2>
              <p className="modal-meta">
                <span>{(item.file.size / 1024).toFixed(1)} KB</span> · <span>{item.kind}</span>
                {item.phase === 'done' && <span className="clean-marker">· Cleaned version available</span>}
              </p>
            </div>
          </div>
          <button className="icon-button close-btn" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </header>

        {/* Modal Navigation Tabs */}
        <nav className="modal-nav">
          {analysis.isAi && (
            <button
              className={`modal-nav-item ${activeTab === 'ai' ? 'active' : ''}`}
              onClick={() => setActiveTab('ai')}
            >
              <Bot size={15} /> AI Origin & Prompt
            </button>
          )}
          {(camera.isCamera || privacy.hasGps) && (
            <button
              className={`modal-nav-item ${activeTab === 'camera' ? 'active' : ''}`}
              onClick={() => setActiveTab('camera')}
            >
              <Camera size={15} /> Camera & Privacy
            </button>
          )}
          <button
            className={`modal-nav-item ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <Sliders size={15} /> All Tags ({Object.keys(allFields).length})
          </button>
        </nav>

        {/* Modal Content Body */}
        <div className="modal-body">
          {/* TAB 1: AI ORIGIN & PROMPT */}
          {activeTab === 'ai' && (
            <div className="tab-pane ai-pane">
              <div className="ai-banner">
                <div className="ai-banner-icon"><Bot size={24} /></div>
                <div>
                  <h3>AI Generator: <strong>{ai.generator}</strong></h3>
                  <p>Source marker: {ai.rawSource || 'Discovered in file chunks'}</p>
                </div>
                {ai.model && <div className="ai-model-tag">Model: {ai.model}</div>}
              </div>

              {ai.prompt ? (
                <div className="prompt-card">
                  <div className="prompt-header">
                    <span><Sparkles size={14} /> Positive Prompt</span>
                    <button
                      className="button ghost small copy-btn"
                      onClick={() => handleCopy(ai.prompt, 'prompt')}
                    >
                      {copiedPrompt ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy Prompt</>}
                    </button>
                  </div>
                  <pre className="prompt-text">{ai.prompt}</pre>
                </div>
              ) : (
                <div className="empty-section">
                  <p>No textual prompt was stored in the file headers, but AI tool markers were verified.</p>
                </div>
              )}

              {ai.negativePrompt && (
                <div className="prompt-card negative">
                  <div className="prompt-header">
                    <span><AlertTriangle size={14} /> Negative Prompt</span>
                    <button
                      className="button ghost small copy-btn"
                      onClick={() => handleCopy(ai.negativePrompt, 'neg')}
                    >
                      {copiedNeg ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                    </button>
                  </div>
                  <pre className="prompt-text">{ai.negativePrompt}</pre>
                </div>
              )}

              {/* AI Parameters Grid */}
              {(ai.seed || ai.sampler || ai.steps || ai.cfgScale || Object.keys(ai.extraParams || {}).length > 0) && (
                <div className="params-section">
                  <h4>Generation Parameters</h4>
                  <div className="params-grid">
                    {ai.seed && (
                      <div className="param-tile">
                        <span>Seed</span>
                        <strong>{ai.seed}</strong>
                      </div>
                    )}
                    {ai.sampler && (
                      <div className="param-tile">
                        <span>Sampler</span>
                        <strong>{ai.sampler}</strong>
                      </div>
                    )}
                    {ai.steps && (
                      <div className="param-tile">
                        <span>Steps</span>
                        <strong>{ai.steps}</strong>
                      </div>
                    )}
                    {ai.cfgScale && (
                      <div className="param-tile">
                        <span>CFG Scale</span>
                        <strong>{ai.cfgScale}</strong>
                      </div>
                    )}
                    {Object.entries(ai.extraParams || {}).map(([k, v]) => (
                      <div className="param-tile" key={k}>
                        <span>{humanKey(k)}</span>
                        <strong>{String(v)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: CAMERA & PRIVACY */}
          {activeTab === 'camera' && (
            <div className="tab-pane camera-pane">
              {privacy.hasGps && (
                <div className="privacy-warning-box">
                  <div className="warning-icon"><ShieldAlert size={24} /></div>
                  <div className="warning-content">
                    <h4>Exact Location Exposed</h4>
                    <p>This image contains GPS coordinates where it was taken: <strong>{privacy.formattedLocation}</strong></p>
                    {privacy.latitude != null && privacy.longitude != null && (
                      <a
                        href={`https://www.google.com/maps?q=${privacy.latitude},${privacy.longitude}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="map-link"
                      >
                        <ExternalLink size={13} /> View on Google Maps
                      </a>
                    )}
                  </div>
                </div>
              )}

              <div className="camera-grid">
                <div className="info-tile">
                  <span>Device</span>
                  <strong>{[camera.make, camera.model].filter(Boolean).join(' ') || 'Unknown Device'}</strong>
                </div>
                {camera.lens && (
                  <div className="info-tile">
                    <span>Lens</span>
                    <strong>{camera.lens}</strong>
                  </div>
                )}
                {camera.exposure && (
                  <div className="info-tile">
                    <span>Exposure Specs</span>
                    <strong>{camera.exposure}</strong>
                  </div>
                )}
                {camera.focalLength && (
                  <div className="info-tile">
                    <span>Focal Length</span>
                    <strong>{camera.focalLength}</strong>
                  </div>
                )}
                {camera.dateTime && (
                  <div className="info-tile">
                    <span>Captured Date</span>
                    <strong>{camera.dateTime}</strong>
                  </div>
                )}
                {camera.software && (
                  <div className="info-tile">
                    <span>Software / OS</span>
                    <strong>{camera.software}</strong>
                  </div>
                )}
                {privacy.author && (
                  <div className="info-tile">
                    <span>Artist / Author</span>
                    <strong>{privacy.author}</strong>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: ALL RAW TAGS */}
          {activeTab === 'all' && (
            <div className="tab-pane all-pane">
              <div className="filter-row">
                <div className="search-wrap">
                  <Search size={15} />
                  <input
                    type="text"
                    placeholder="Search metadata tags (e.g. ISO, GPS, Software, Date)..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                  {search && (
                    <button className="clear-search" onClick={() => setSearch('')}>
                      <X size={14} />
                    </button>
                  )}
                </div>
                <button
                  className="button ghost small"
                  onClick={() => handleCopy(JSON.stringify(allFields, null, 2), 'all')}
                >
                  {copiedAll ? <><Check size={14} /> Copied JSON</> : <><Copy size={14} /> Copy JSON</>}
                </button>
              </div>

              {filteredFields.length > 0 ? (
                <div className="raw-table">
                  {filteredFields.map(([k, v]) => (
                    <div className="raw-row" key={k}>
                      <div className="raw-key">{humanKey(k)}</div>
                      <div className="raw-val" title={String(v)}>{String(v)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-meta">
                  {Object.keys(allFields).length === 0
                    ? 'No metadata tags found in this file.'
                    : 'No matching tags found for your search.'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Bar */}
        <footer className="modal-footer">
          <div className="footer-left">
            {item.phase === 'done' ? (
              <span className="cleaned-badge">
                <Check size={15} /> Cleaned version ready for download
              </span>
            ) : (
              <span className="privacy-hint">
                <ShieldCheck size={15} /> Cleaning creates a private copy without any tags
              </span>
            )}
          </div>
          <div className="footer-actions">
            {item.phase === 'done' && item.resultUrl ? (
              <button
                className="button primary"
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = item.resultUrl;
                  a.download = item.result.name;
                  a.click();
                }}
              >
                <Download size={16} /> Download Cleaned File
              </button>
            ) : (
              <button
                className="button primary"
                disabled={isProcessing}
                onClick={() => onClean(item)}
              >
                <ShieldCheck size={16} /> Clean Metadata Now
              </button>
            )}
            <button className="button ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
