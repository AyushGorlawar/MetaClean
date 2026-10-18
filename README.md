# MetaClean

A browser-only React + Vite metadata-cleaning prototype with image re-encoding, FFmpeg WebAssembly video re-encoding, batch processing, metadata previews, and post-clean scans.

## Requirements
- Node.js 18+ (Node 20 LTS recommended)
- npm
- A modern browser. Video processing is memory-intensive; desktop Chrome/Edge generally works best.

## Run locally
```bash
npm install
npm run dev
```
Open the local URL printed by Vite. To test on a phone connected to the same Wi-Fi:
```bash
npm run dev -- --host 0.0.0.0
```
Use the network URL printed by Vite. Some browsers restrict advanced WebAssembly features on non-secure origins; localhost is treated as secure, and deployed sites should use HTTPS.

## Build for static hosting
```bash
npm run build
npm run preview
```
Upload the contents of `dist/` to static hosting. No application backend is required.

## How it works
- **Images:** `createImageBitmap` decodes the image and a canvas re-encodes it as JPEG, PNG, or WebP. This drops the original file's EXIF/XMP/IPTC chunks rather than trying to edit them in place. Re-encoding can alter quality; browser decoding may not preserve animation (animated formats are intentionally not listed as supported).
- **Videos:** FFmpeg WebAssembly re-encodes the first video stream and optional audio stream into MP4, disables metadata and chapter mapping, and clears common tags. Re-encoding is slower and can change codec, quality, size, timestamps, and compatibility. The input file stays in the browser; the FFmpeg engine is fetched from jsDelivr at runtime.
- **Preview:** `exifr` inspects common image metadata; `mediainfo.js` inspects metadata fields exposed by MediaInfo for video containers/tracks.
- **Verification:** the app scans the output and reports whether any metadata fields matched its current scanner. It does not claim forensic proof that every possible proprietary/hidden field has been removed.

## Important limitations
1. Browser media APIs and metadata parsers do not expose every field for every format.
2. Video conversion uses substantial CPU/RAM and can fail for large files or mobile devices with limited memory.
3. Current video output is MP4/H.264 + AAC, so unsupported source codecs may fail. DRM-protected files are not supported.
4. FFmpeg core and MediaInfo WASM are downloaded from a CDN on first use. Files selected by users are not sent to that CDN, but the site needs network access to load these libraries. For a strict offline deployment, vendor and self-host the WASM assets and adjust the loader URLs.
5. A clean metadata scan is not a guarantee of anonymity. Files can still reveal content through visible objects, faces, audio, or other non-metadata signals.
6. For high-sensitivity use, independently inspect the output with a separate metadata tool before sharing.

## Privacy and deployment notes
- No upload endpoint, analytics, cookies, or storage is implemented.
- The Google Fonts import is optional; remove it from `src/styles.css` if you want no third-party font requests.
- Runtime WASM assets currently load from jsDelivr. For stricter supply-chain control, self-host pinned assets and review dependency versions.
- Add your own Content-Security-Policy and other security headers at the hosting layer. Test FFmpeg/WebAssembly under those headers before deployment.

## Supported inputs
- Images: JPEG/JPG, PNG, WebP
- Videos: MP4, MOV, M4V, WebM (the browser/FFmpeg build must support the source)

## Next hardening steps
- Vendor and pin the FFmpeg core and MediaInfo WASM assets.
- Add automated browser tests with sample files containing known EXIF/GPS and video tags.
- Add ZIP export for batch downloads.
- Add explicit file-size warnings and a cancellable processing queue.
- Validate on target mobile devices and major browsers before public launch.
