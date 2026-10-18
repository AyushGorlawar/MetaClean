import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldCheck, UploadCloud, Image as ImageIcon, Video, FileCheck2, FileWarning,
  Trash2, Download, CheckCircle2, AlertCircle, LoaderCircle, LockKeyhole,
  ChevronDown, X, Files, ScanSearch, RotateCcw, Bot, Sparkles, Camera, MapPin, Eye
} from 'lucide-react';
import * as exifr from 'exifr';
import { analyzeMediaMetadata, analyzeVideoMetadata } from './metadataAnalyzer.js';
import MetadataModal from './MetadataModal.jsx';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];
const MAX_FILES = 20;

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function extOf(name) { return (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase(); }
function isImage(file) { return IMAGE_TYPES.includes(file.type) || ['.jpg', '.jpeg', '.png', '.webp'].includes(extOf(file.name)); }
function isVideo(file) { return file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(extOf(file.name)); }
function cleanName(name) { return name.replace(/\.[^.]+$/, '') + '-cleaned'; }
function humanKey(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function isInterestingKey(key) {
  return /gps|latitude|longitude|date|time|make|model|software|artist|author|comment|description|location|title|copyright|encoder|creation|tag|metadata|camera|prompt|seed|sampler/i.test(key);
}
function flattenMetadata(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !(value instanceof Date) && !ArrayBuffer.isView(value)) {
      flattenMetadata(value, path, out);
    } else if (isInterestingKey(path) || value instanceof Date) {
      out[path] = value instanceof Date ? value.toISOString() : String(value);
    }
  }
  return out;
}
async function inspectImage(file) {
  try {
    let rawExif = {};
    try {
      // exifr parses the File object directly with chunked streaming (no full-file buffer needed)
      rawExif = await exifr.parse(file, {
        tiff: true,
        exif: true,
        gps: true,
        xmp: true,
        iptc: true,
        jfif: true,
        icc: false,
        mergeOutput: true
      }) || {};
    } catch {
      rawExif = {};
    }

    // Read only the first 512KB slice for PNG chunks and C2PA markers (instant <1ms, zero memory bloat)
    const headerSlice = await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer();
    const analysis = await analyzeMediaMetadata(file, rawExif, headerSlice);
    const fields = flattenMetadata(rawExif || {});
    for (const [k, v] of Object.entries(analysis.allFields)) {
      if (!fields[k]) fields[k] = v;
    }
    return {
      supported: true,
      fields,
      analysis,
      note: 'Image metadata and AI origin scan completed.'
    };
  } catch (error) {
    return { supported: false, fields: {}, analysis: null, note: `Could not fully inspect this image: ${error.message}` };
  }
}
async function stripImage(file) {
  // Canvas decoding + fresh encoding does not carry over source EXIF/XMP/IPTC chunks.
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas is unavailable in this browser.');
    ctx.drawImage(bitmap, 0, 0);
    const type = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Browser could not encode this image.')), type, 0.94));
    return new File([blob], `${cleanName(file.name)}${type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'}`, { type, lastModified: Date.now() });
  } finally { bitmap.close?.(); }
}
async function loadMediaInfo() {
  const mod = await import('mediainfo.js');
  const factory = mod.default || mod;
  return factory({ format: 'object', locateFile: (path) => `https://cdn.jsdelivr.net/npm/mediainfo.js@0.3.6/dist/${path}` });
}
async function inspectVideo(file) {
  let mediaInfo;
  try {
    mediaInfo = await loadMediaInfo();
    const result = await mediaInfo.analyzeData(() => file.size, async (chunkSize, offset) => {
      const chunk = file.slice(offset, offset + chunkSize);
      return new Uint8Array(await chunk.arrayBuffer());
    });
    const fields = {};
    const tracks = result?.media?.track || [];
    for (const track of tracks) {
      for (const [key, value] of Object.entries(track)) {
        if (isInterestingKey(key) && value !== '' && value != null) fields[`${track['@type'] || 'Track'}.${key}`] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
    mediaInfo.close?.();
    const analysis = analyzeVideoMetadata(file, fields);
    return { supported: true, fields, analysis, note: 'Video metadata scan completed for fields exposed by MediaInfo.' };
  } catch (error) {
    mediaInfo?.close?.();
    return { supported: false, fields: {}, analysis: null, note: `Video metadata inspection failed: ${error.message}` };
  }
}
let ffmpegPromise;
async function getFFmpeg(onLog) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]);
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => onLog?.(message));
      const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
      });
      return ffmpeg;
    })().catch(error => { ffmpegPromise = null; throw error; });
  }
  return ffmpegPromise;
}
async function stripVideo(file, setLog) {
  const ffmpeg = await getFFmpeg(setLog);
  const input = `input${extOf(file.name) || '.mp4'}`;
  const output = 'output.mp4';
  await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
  try {
    await ffmpeg.exec([
      '-i', input,
      '-map', '0:v:0', '-map', '0:a?',
      '-map_metadata', '-1', '-map_chapters', '-1',
      '-metadata', 'title=', '-metadata', 'comment=', '-metadata', 'artist=',
      '-metadata', 'author=', '-metadata', 'description=', '-metadata', 'creation_time=',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', output
    ]);
    const bytes = await ffmpeg.readFile(output);
    return new File([bytes], `${cleanName(file.name)}.mp4`, { type: 'video/mp4', lastModified: Date.now() });
  } finally {
    await ffmpeg.deleteFile(input).catch(() => { });
    await ffmpeg.deleteFile(output).catch(() => { });
  }
}
function MetadataList({ title, fields, emptyText }) {
  const entries = Object.entries(fields || {});
  return <div className="meta-block">
    <div className="meta-heading">{title}<span>{entries.length} fields</span></div>
    {entries.length ? <div className="meta-list">{entries.map(([key, value]) => <div className="meta-row" key={key}><span>{humanKey(key)}</span><strong title={String(value)}>{String(value).slice(0, 130)}</strong></div>)}</div> : <p className="empty-meta">{emptyText}</p>}
  </div>;
}
function App() {
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [showDetails, setShowDetails] = useState({});
  const [inspectingId, setInspectingId] = useState(null);
  const inputRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => itemsRef.current.forEach(item => { if (item.resultUrl) URL.revokeObjectURL(item.resultUrl); }), []);

  const addFiles = useCallback(async (list) => {
    const incoming = Array.from(list || []);
    const accepted = incoming.filter(file => isImage(file) || isVideo(file));
    const rejected = incoming.length - accepted.length;
    const room = Math.max(0, MAX_FILES - itemsRef.current.length);
    const selected = accepted.slice(0, room);
    if (!selected.length) {
      setStatus(rejected ? 'Choose JPG, PNG, WebP, MP4, MOV, M4V or WebM files.' : `You can process up to ${MAX_FILES} files at once.`);
      return;
    }
    setStatus(rejected ? `${rejected} unsupported file(s) skipped. ` : '');
    const newItems = selected.map(file => ({ id: crypto.randomUUID(), file, kind: isImage(file) ? 'image' : 'video', phase: 'ready', before: null, after: null, result: null, resultUrl: null, progress: 0, error: '' }));
    setItems(prev => [...prev, ...newItems]);
    // Inspect in parallel; each file stays in this browser tab.
    await Promise.all(newItems.map(async item => {
      const scan = item.kind === 'image' ? await inspectImage(item.file) : await inspectVideo(item.file);
      setItems(prev => prev.map(row => row.id === item.id ? { ...row, before: scan } : row));
    }));
  }, []);

  const processOne = async (item) => {
    setItems(prev => prev.map(row => row.id === item.id ? { ...row, phase: 'processing', progress: 5, error: '' } : row));
    try {
      const result = item.kind === 'image'
        ? await stripImage(item.file)
        : await stripVideo(item.file, message => {
          const match = message.match(/frame=\s*(\d+)/);
          if (match) setItems(prev => prev.map(row => row.id === item.id ? { ...row, progress: Math.min(90, 10 + Number(match[1]) / 20) } : row));
        });
      const after = item.kind === 'image' ? await inspectImage(result) : await inspectVideo(result);
      const resultUrl = URL.createObjectURL(result);
      setItems(prev => prev.map(row => {
        if (row.id !== item.id) return row;
        if (row.resultUrl) URL.revokeObjectURL(row.resultUrl);
        return { ...row, result, resultUrl, after, phase: 'done', progress: 100 };
      }));
    } catch (error) {
      setItems(prev => prev.map(row => row.id === item.id ? { ...row, phase: 'error', error: error?.message || 'Processing failed.' } : row));
    }
  };

  const processAll = async () => {
    if (busy) return;
    const queue = items.filter(item => ['ready', 'error'].includes(item.phase));
    if (!queue.length) return;
    setBusy(true); setStatus('Processing files locally. Video conversion may take several minutes.');
    try {
      for (const item of queue) await processOne(item);
      setStatus('Processing queue finished. Review the verification status before sharing files.');
    } finally { setBusy(false); }
  };

  const removeItem = (id) => {
    setItems(prev => {
      const row = prev.find(item => item.id === id);
      if (row?.resultUrl) URL.revokeObjectURL(row.resultUrl);
      return prev.filter(item => item.id !== id);
    });
    if (inspectingId === id) setInspectingId(null);
  };

  const clearAll = () => {
    items.forEach(item => { if (item.resultUrl) URL.revokeObjectURL(item.resultUrl); });
    setItems([]); setStatus(''); setShowDetails({}); setInspectingId(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const downloadOne = (item) => {
    if (!item.resultUrl) return;
    const a = document.createElement('a'); a.href = item.resultUrl; a.download = item.result.name; a.click();
  };

  const completed = items.filter(i => i.phase === 'done').length;
  const readyCount = items.filter(i => ['ready', 'error'].includes(i.phase)).length;
  const inspectingItem = items.find(i => i.id === inspectingId) || null;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="MetaClean home"><span className="brand-mark"><ShieldCheck size={20} /></span><span>metaclean</span></a>
      <div className="top-badge"><span className="live-dot"></span> AI & Metadata Inspector + Cleaner</div>
    </header>
    <section className="hero">
      <div className="eyebrow"><LockKeyhole size={14} /> 100% PRIVATE & ON-DEVICE</div>
      <h1>Inspect hidden metadata.<br /><span>Remove AI & device origins.</span></h1>
      <p className="hero-copy">Check which AI created an image (Midjourney, Stable Diffusion, DALL-E) or inspect camera specs & GPS coordinates. Remove hidden metadata in 1-click before sharing.</p>
      <div className="trust-row"><span><CheckCircle2 size={15} /> AI Origin Detection</span><span><CheckCircle2 size={15} /> No Media Uploads</span><span><CheckCircle2 size={15} /> Free & Private</span></div>
    </section>
    <section className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
      <input ref={inputRef} type="file" multiple accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.m4v,.webm,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} hidden />
      <div className="upload-icon"><UploadCloud size={27} /></div>
      <h2>Drop your files here to inspect & clean</h2>
      <p>Supports AI images, photos, and video containers</p>
      <button className="button primary" onClick={() => inputRef.current?.click()}><Files size={17} /> Select files</button>
      <div className="file-types"><span><ImageIcon size={14} /> JPG · PNG · WebP</span><span><Video size={14} /> MP4 · MOV · WebM</span></div>
      <p className="limit-note">Up to {MAX_FILES} files per batch. All analysis & cleaning is performed inside your browser.</p>
    </section>
    {status && <div className="status-note" role="status"><AlertCircle size={16} />{status}</div>}
    {items.length > 0 && <section className="workspace">
      <div className="workspace-head">
        <div><div className="section-kicker">WORKSPACE</div><h2>Your files <span className="count">{items.length}</span></h2><p>Click any file or badge to inspect AI prompts, camera specs, and raw metadata.</p></div>
        <button className="button ghost small" onClick={clearAll} disabled={busy}><Trash2 size={15} /> Clear all</button>
      </div>
      <div className="batch-summary">
        <div><span className="summary-number">{completed}</span><span>Cleaned</span></div>
        <div><span className="summary-number">{readyCount}</span><span>Waiting</span></div>
        <div><span className="summary-number">{items.filter(i => i.phase === 'error').length}</span><span>Failed</span></div>
        <button className="button primary process-button" onClick={processAll} disabled={busy || readyCount === 0}>{busy ? <><LoaderCircle className="spin" size={16} /> Processing…</> : <><ShieldCheck size={16} /> Clean {readyCount || ''} file{readyCount === 1 ? '' : 's'}</>}</button>
      </div>
      <div className="file-list">
        {items.map(item => {
          const detailsOpen = !!showDetails[item.id];
          const remaining = item.after?.fields ? Object.keys(item.after.fields).length : null;
          const verified = item.phase === 'done' && item.after?.supported && remaining === 0;
          const hasResidual = item.phase === 'done' && item.after?.supported && remaining > 0;
          const analysis = item.before?.analysis;

          return <article className="file-card" key={item.id}>
            <div className="file-main">
              <div className={`file-icon ${item.kind}`}>{item.kind === 'image' ? <ImageIcon size={20} /> : <Video size={20} />}</div>
              <div className="file-info">
                <div className="file-title-wrap">
                  <h3 title={item.file.name}>{item.file.name}</h3>
                  {analysis?.isAi && (
                    <button
                      className="origin-pill ai clickable"
                      onClick={() => setInspectingId(item.id)}
                      title="AI Origin Detected! Click to inspect prompt & settings"
                    >
                      <Bot size={13} /> {analysis.ai.generator}
                    </button>
                  )}
                  {analysis?.privacy?.hasGps && !analysis?.isAi && (
                    <button
                      className="origin-pill warning clickable"
                      onClick={() => setInspectingId(item.id)}
                      title="GPS Location Found! Click to view coordinates"
                    >
                      <MapPin size={13} /> GPS Found
                    </button>
                  )}
                  {analysis?.camera?.isCamera && !analysis?.isAi && !analysis?.privacy?.hasGps && (
                    <button
                      className="origin-pill camera clickable"
                      onClick={() => setInspectingId(item.id)}
                      title="Camera EXIF Detected - Click to view"
                    >
                      <Camera size={13} /> {analysis.camera.make} {analysis.camera.model}
                    </button>
                  )}
                </div>
                <p>{formatBytes(item.file.size)} <span>·</span> {item.kind === 'image' ? 'Image' : 'Video'}</p>

                <div className="file-meta-row">
                  <div className={`state ${item.phase === 'done' ? (verified ? 'success' : hasResidual ? 'warning' : 'neutral') : item.phase === 'error' ? 'danger' : ''}`}>
                    {item.phase === 'ready' && <><ScanSearch size={14} /> {item.before ? 'Scanned · Ready to clean' : 'Inspecting metadata…'}</>}
                    {item.phase === 'processing' && <><LoaderCircle className="spin" size={14} /> Processing locally · {Math.round(item.progress)}%</>}
                    {item.phase === 'done' && verified && <><CheckCircle2 size={14} /> Verified: no detected metadata fields remain</>}
                    {item.phase === 'done' && hasResidual && <><FileWarning size={14} /> Review: {remaining} metadata field(s) still detected</>}
                    {item.phase === 'done' && !verified && !hasResidual && <><AlertCircle size={14} /> Cleaned; verification incomplete</>}
                    {item.phase === 'error' && <><AlertCircle size={14} /> {item.error}</>}
                  </div>

                  {item.before?.supported && (
                    <button
                      className="inspect-quick-btn"
                      onClick={() => setInspectingId(item.id)}
                      title="Open interactive Metadata & AI Inspector"
                    >
                      <Sparkles size={13} /> View Metadata
                    </button>
                  )}
                </div>

                {item.phase === 'processing' && <div className="progress"><span style={{ width: `${item.progress}%` }} /></div>}
              </div>
              <div className="file-actions">
                <button
                  className="icon-button inspect"
                  title="Open Metadata & AI Inspector"
                  onClick={() => setInspectingId(item.id)}
                >
                  <Eye size={18} />
                </button>
                <button className="icon-button" title="Show metadata comparison" onClick={() => setShowDetails(prev => ({ ...prev, [item.id]: !prev[item.id] }))}><ChevronDown className={detailsOpen ? 'rotate' : ''} size={18} /></button>
                {item.phase === 'done' && <button className="icon-button download" title="Download cleaned file" onClick={() => downloadOne(item)}><Download size={18} /></button>}
                <button className="icon-button" title="Remove from list" disabled={busy} onClick={() => removeItem(item.id)}><X size={18} /></button>
              </div>
            </div>
            {detailsOpen && <div className="comparison">
              <MetadataList title="Before cleaning" fields={item.before?.fields} emptyText={item.before?.supported ? 'No matching metadata fields detected by this scanner.' : item.before?.note || 'Scan in progress…'} />
              {item.phase === 'done' && <MetadataList title="After cleaning" fields={item.after?.fields} emptyText={item.after?.supported ? 'No matching metadata fields detected by this scanner.' : item.after?.note || 'Could not verify output.'} />}
              {item.phase === 'done' && <p className="verify-footnote"><FileCheck2 size={14} /> Verification covers fields exposed by the current scanner, not every possible byte or proprietary metadata block.</p>}
            </div>}
          </article>;
        })}
      </div>
      <div className="privacy-callout"><ShieldCheck size={20} /><div><strong>Your files stay in this tab</strong><p>Processing happens locally. Refreshing or closing this page clears the workspace and temporary download URLs.</p></div></div>
    </section>}
    <section className="how-section">
      <div className="section-kicker">HOW IT WORKS</div><h2>Three steps to inspect and clean.</h2>
      <div className="how-grid">
        <div className="how-card"><span>01</span><Sparkles size={21} /><h3>Inspect & Detect AI</h3><p>Instantly reveal AI generators (Midjourney, Stable Diffusion, DALL-E), prompts, seeds, camera specs, or GPS coordinates.</p></div>
        <div className="how-card"><span>02</span><ShieldCheck size={21} /><h3>Clean 100% Locally</h3><p>Re-encode images and videos directly in your browser without uploading to any server, stripping all tags.</p></div>
        <div className="how-card"><span>03</span><FileCheck2 size={21} /><h3>Verify & Download</h3><p>Compare Before vs After to verify that all hidden parameters and tracking markers were eradicated.</p></div>
      </div>
    </section>
    <footer><a className="brand footer-brand" href="#"><span className="brand-mark"><ShieldCheck size={17} /></span><span>metaclean</span></a><p className="footer-disclaimer">We never store your files or upload them to any server. All processing happens directly on your device, ensuring complete privacy.</p></footer>

    {/* Metadata & AI Inspector Modal */}
    {inspectingItem && (
      <MetadataModal
        item={inspectingItem}
        onClose={() => setInspectingId(null)}
        onClean={processOne}
        isProcessing={busy}
      />
    )}
  </main>;
}

export default App;