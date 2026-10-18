/**
 * Metadata and AI Origin Analyzer
 * Detects AI generation (Midjourney, Stable Diffusion, DALL-E, Adobe Firefly, C2PA),
 * Camera information, GPS locations, and parses prompts and parameters.
 */

// Helper to decompress deflate streams (supported in modern browsers)
async function decompressDeflate(bytes) {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Response(bytes).body.pipeThrough(ds);
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(arrayBuffer);
  } catch {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Response(bytes).body.pipeThrough(ds);
      const arrayBuffer = await new Response(stream).arrayBuffer();
      return new TextDecoder('utf-8').decode(arrayBuffer);
    } catch {
      return '';
    }
  }
}

/**
 * Parse PNG text chunks (tEXt, iTXt, zTXt) directly from ArrayBuffer
 */
export async function parsePngTextChunks(arrayBuffer) {
  const chunks = {};
  if (!arrayBuffer || arrayBuffer.byteLength < 8) return chunks;

  const view = new DataView(arrayBuffer);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
    return chunks;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = 8;
  // Metadata chunks are almost always in the first 1MB before image raster data (IDAT)
  const maxOffset = Math.min(arrayBuffer.byteLength, 1024 * 1024);

  while (offset + 8 <= maxOffset) {
    const length = view.getUint32(offset);
    if (offset + 8 + length > arrayBuffer.byteLength) break;

    const type = decoder.decode(new Uint8Array(arrayBuffer, offset + 4, 4));
    const dataOffset = offset + 8;

    if (type === 'tEXt') {
      const bytes = new Uint8Array(arrayBuffer, dataOffset, length);
      const nullIdx = bytes.indexOf(0);
      if (nullIdx !== -1) {
        const key = decoder.decode(bytes.subarray(0, nullIdx));
        const val = decoder.decode(bytes.subarray(nullIdx + 1));
        if (key && val) chunks[key] = val;
      }
    } else if (type === 'zTXt') {
      const bytes = new Uint8Array(arrayBuffer, dataOffset, length);
      const nullIdx = bytes.indexOf(0);
      if (nullIdx !== -1 && nullIdx + 2 < bytes.length) {
        const key = decoder.decode(bytes.subarray(0, nullIdx));
        const compressed = bytes.subarray(nullIdx + 2);
        try {
          const val = await decompressDeflate(compressed);
          if (key && val) chunks[key] = val;
        } catch {
          // ignore decompression failure
        }
      }
    } else if (type === 'iTXt') {
      const bytes = new Uint8Array(arrayBuffer, dataOffset, length);
      const nullIdx = bytes.indexOf(0);
      if (nullIdx !== -1 && nullIdx + 3 < bytes.length) {
        const key = decoder.decode(bytes.subarray(0, nullIdx));
        const compFlag = bytes[nullIdx + 1];
        let textStart = nullIdx + 3;
        let nullCount = 0;
        for (let i = textStart; i < bytes.length; i++) {
          if (bytes[i] === 0) {
            nullCount++;
            if (nullCount === 2) {
              textStart = i + 1;
              break;
            }
          }
        }
        if (textStart < bytes.length) {
          if (compFlag === 0) {
            const val = decoder.decode(bytes.subarray(textStart));
            if (key && val) chunks[key] = val;
          } else {
            try {
              const val = await decompressDeflate(bytes.subarray(textStart));
              if (key && val) chunks[key] = val;
            } catch {
              // ignore
            }
          }
        }
      }
    } else if (type === 'IDAT') {
      // If we already captured parameters or prompt, stop scan immediately
      if (chunks.parameters || chunks.prompt || chunks.workflow) {
        break;
      }
    } else if (type === 'IEND') {
      break;
    }

    offset += 8 + length + 4;
  }

  return chunks;
}

/**
 * Parse Automatic1111 / WebUI parameters string
 */
function parseA1111Params(rawText) {
  const result = {
    prompt: '',
    negativePrompt: '',
    model: '',
    seed: '',
    sampler: '',
    steps: '',
    cfgScale: '',
    params: {}
  };

  if (!rawText || typeof rawText !== 'string') return result;

  const negIndex = rawText.indexOf('Negative prompt:');
  const stepsIndex = rawText.search(/\bSteps:\s*\d+/i);

  if (negIndex !== -1) {
    result.prompt = rawText.slice(0, negIndex).trim();
    if (stepsIndex !== -1 && stepsIndex > negIndex) {
      result.negativePrompt = rawText.slice(negIndex + 16, stepsIndex).trim();
    } else {
      result.negativePrompt = rawText.slice(negIndex + 16).trim();
    }
  } else if (stepsIndex !== -1) {
    result.prompt = rawText.slice(0, stepsIndex).trim();
  } else {
    result.prompt = rawText.trim();
  }

  const paramSection = stepsIndex !== -1 ? rawText.slice(stepsIndex) : '';
  if (paramSection) {
    const pairs = paramSection.split(/,\s*(?=[A-Za-z0-9_ -]+:)/);
    for (const pair of pairs) {
      const colon = pair.indexOf(':');
      if (colon !== -1) {
        const k = pair.slice(0, colon).trim();
        const v = pair.slice(colon + 1).trim();
        result.params[k] = v;
        const lowerK = k.toLowerCase();
        if (lowerK === 'model') result.model = v;
        else if (lowerK === 'seed') result.seed = v;
        else if (lowerK === 'sampler') result.sampler = v;
        else if (lowerK === 'steps') result.steps = v;
        else if (lowerK === 'cfg scale') result.cfgScale = v;
      }
    }
  }

  return result;
}

/**
 * Scan raw array buffer for C2PA or synthetic media signatures using fast native decode
 */
function scanBufferForAiSignatures(arrayBuffer) {
  if (!arrayBuffer) return null;
  // Header inspection: check first 256KB where C2PA / XMP manifests live
  const len = Math.min(arrayBuffer.byteLength, 256 * 1024);
  const decoder = new TextDecoder('latin1');
  const ascii = decoder.decode(new Uint8Array(arrayBuffer, 0, len));

  if (/trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia/i.test(ascii)) {
    if (/openai|dall[·\- ]*e/i.test(ascii)) return { generator: 'DALL·E 3 (OpenAI)', standard: 'C2PA / IPTC' };
    if (/firefly|photoshop/i.test(ascii)) return { generator: 'Adobe Firefly', standard: 'C2PA / Content Credentials' };
    if (/microsoft|bing/i.test(ascii)) return { generator: 'Bing Image Creator', standard: 'C2PA / IPTC' };
    return { generator: 'AI Generated Media', standard: 'C2PA (trainedAlgorithmicMedia)' };
  }

  if (/c2pa\.claim|c2pa\.manifest/i.test(ascii)) {
    if (/openai|dall/i.test(ascii)) return { generator: 'DALL·E 3 (OpenAI)', standard: 'C2PA Manifest' };
    if (/firefly/i.test(ascii)) return { generator: 'Adobe Firefly', standard: 'C2PA Manifest' };
    return { generator: 'C2PA Content Credentials (AI/Digital Origin)', standard: 'C2PA' };
  }

  if (/\bMidjourney\b/i.test(ascii)) {
    const mjMatch = ascii.match(/Midjourney[^\n\r"]*/i);
    return { generator: 'Midjourney', standard: 'Embedded Tag', note: mjMatch ? mjMatch[0] : '' };
  }

  return null;
}

/**
 * Main analysis function that inspects EXIF, PNG chunks, and raw signatures
 */
export async function analyzeMediaMetadata(file, exifrData = {}, arrayBuffer = null) {
  let pngChunks = {};
  if (file?.type === 'image/png' || file?.name?.toLowerCase().endsWith('.png')) {
    if (arrayBuffer) {
      pngChunks = await parsePngTextChunks(arrayBuffer);
    }
  }

  const allFields = {};
  for (const [k, v] of Object.entries(exifrData || {})) {
    if (v != null && typeof v !== 'object') {
      allFields[k] = String(v);
    } else if (v instanceof Date) {
      allFields[k] = v.toISOString();
    }
  }
  for (const [k, v] of Object.entries(pngChunks)) {
    allFields[`PNG.${k}`] = String(v);
  }

  const result = {
    isAi: false,
    ai: {
      isAi: false,
      generator: '',
      confidence: 'none',
      prompt: '',
      negativePrompt: '',
      model: '',
      seed: '',
      sampler: '',
      steps: '',
      cfgScale: '',
      extraParams: {},
      rawSource: '',
      details: ''
    },
    camera: {
      isCamera: false,
      make: exifrData?.Make || '',
      model: exifrData?.Model || '',
      lens: exifrData?.LensModel || exifrData?.Lens || '',
      exposure: '',
      iso: exifrData?.ISO ? `ISO ${exifrData.ISO}` : '',
      aperture: exifrData?.FNumber ? `f/${exifrData.FNumber}` : '',
      shutter: exifrData?.ExposureTime ? (exifrData.ExposureTime < 1 ? `1/${Math.round(1 / exifrData.ExposureTime)}s` : `${exifrData.ExposureTime}s`) : '',
      focalLength: exifrData?.FocalLength ? `${exifrData.FocalLength}mm` : '',
      dateTime: exifrData?.DateTimeOriginal ? String(exifrData.DateTimeOriginal) : (exifrData?.CreateDate ? String(exifrData.CreateDate) : ''),
      software: exifrData?.Software || ''
    },
    privacy: {
      hasGps: false,
      latitude: exifrData?.latitude ?? null,
      longitude: exifrData?.longitude ?? null,
      formattedLocation: null,
      hasAuthor: !!(exifrData?.Artist || exifrData?.author || exifrData?.Creator),
      author: exifrData?.Artist || exifrData?.author || exifrData?.Creator || null,
      software: exifrData?.Software || null
    },
    badge: {
      title: 'No Metadata',
      description: 'Clean / Stripped file',
      variant: 'clean'
    },
    allFields
  };

  const exposureParts = [result.camera.shutter, result.camera.aperture, result.camera.iso].filter(Boolean);
  if (exposureParts.length) {
    result.camera.exposure = exposureParts.join(' · ');
  }

  if (result.camera.make || result.camera.model) {
    result.camera.isCamera = true;
  }

  if (result.privacy.latitude != null && result.privacy.longitude != null) {
    result.privacy.hasGps = true;
    const lat = Number(result.privacy.latitude);
    const lng = Number(result.privacy.longitude);
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    result.privacy.formattedLocation = `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lng).toFixed(4)}° ${lngDir}`;
  }

  // 1. Check Stable Diffusion / Automatic1111 / WebUI in PNG chunks
  if (pngChunks.parameters) {
    result.isAi = true;
    result.ai.isAi = true;
    result.ai.generator = 'Stable Diffusion (A1111 / WebUI)';
    result.ai.confidence = 'high';
    result.ai.rawSource = 'PNG parameters chunk';
    const parsed = parseA1111Params(pngChunks.parameters);
    result.ai.prompt = parsed.prompt;
    result.ai.negativePrompt = parsed.negativePrompt;
    result.ai.model = parsed.model;
    result.ai.seed = parsed.seed;
    result.ai.sampler = parsed.sampler;
    result.ai.steps = parsed.steps;
    result.ai.cfgScale = parsed.cfgScale;
    result.ai.extraParams = parsed.params;
  }

  // 2. Check ComfyUI in PNG chunks
  if (!result.isAi && (pngChunks.prompt || pngChunks.workflow)) {
    result.isAi = true;
    result.ai.isAi = true;
    result.ai.generator = 'Stable Diffusion (ComfyUI)';
    result.ai.confidence = 'high';
    result.ai.rawSource = 'ComfyUI Workflow chunk';
    try {
      const promptObj = pngChunks.prompt ? JSON.parse(pngChunks.prompt) : null;
      if (promptObj) {
        const prompts = [];
        for (const node of Object.values(promptObj)) {
          if (node?.class_type === 'CLIPTextEncode' && node?.inputs?.text) {
            prompts.push(String(node.inputs.text));
          }
          if (node?.class_type === 'KSampler' && node?.inputs) {
            if (node.inputs.seed != null) result.ai.seed = String(node.inputs.seed);
            if (node.inputs.steps != null) result.ai.steps = String(node.inputs.steps);
            if (node.inputs.cfg != null) result.ai.cfgScale = String(node.inputs.cfg);
            if (node.inputs.sampler_name) result.ai.sampler = String(node.inputs.sampler_name);
          }
        }
        if (prompts.length > 0) {
          result.ai.prompt = prompts[0];
          if (prompts.length > 1) result.ai.negativePrompt = prompts[1];
        }
      }
    } catch {
      result.ai.prompt = String(pngChunks.prompt).slice(0, 500);
    }
  }

  // 3. Check NovelAI in PNG chunks
  if (!result.isAi && (pngChunks.Software === 'NovelAI' || pngChunks.Comment?.includes('NovelAI') || pngChunks.Description?.includes('NovelAI'))) {
    result.isAi = true;
    result.ai.isAi = true;
    result.ai.generator = 'NovelAI';
    result.ai.confidence = 'high';
    result.ai.rawSource = 'PNG NovelAI metadata';
    result.ai.prompt = pngChunks.Description || pngChunks.Comment || '';
  }

  // 4. Check Midjourney in EXIF / XMP / Description
  const desc = exifrData?.ImageDescription || exifrData?.description || pngChunks?.Description || pngChunks?.parameters || '';
  const software = String(exifrData?.Software || pngChunks?.Software || '');
  const userComment = String(exifrData?.UserComment || '');

  if (!result.isAi && (/midjourney/i.test(software) || /midjourney/i.test(desc) || /--v\s+\d|--ar\s+\d+:\d+/i.test(desc))) {
    result.isAi = true;
    result.ai.isAi = true;
    result.ai.generator = 'Midjourney';
    result.ai.confidence = 'high';
    result.ai.rawSource = 'Image Description / Metadata';
    result.ai.prompt = desc.trim();
    const vMatch = desc.match(/--v\s+([0-9.]+)/i);
    if (vMatch) result.ai.model = `v${vMatch[1]}`;
    const arMatch = desc.match(/--ar\s+([0-9:]+)/i);
    if (arMatch) result.ai.extraParams['Aspect Ratio'] = arMatch[1];
  }

  // 5. Check Stable Diffusion in EXIF UserComment
  if (!result.isAi && (userComment.includes('Steps:') || userComment.includes('Negative prompt:'))) {
    result.isAi = true;
    result.ai.isAi = true;
    result.ai.generator = 'Stable Diffusion';
    result.ai.confidence = 'high';
    result.ai.rawSource = 'EXIF UserComment';
    const parsed = parseA1111Params(userComment);
    result.ai.prompt = parsed.prompt;
    result.ai.negativePrompt = parsed.negativePrompt;
    result.ai.model = parsed.model;
    result.ai.seed = parsed.seed;
    result.ai.sampler = parsed.sampler;
    result.ai.steps = parsed.steps;
    result.ai.cfgScale = parsed.cfgScale;
    result.ai.extraParams = parsed.params;
  }

  // 6. Check DALL-E / OpenAI / Adobe Firefly / C2PA in EXIF/XMP
  const source = String(exifrData?.Source || exifrData?.Credit || '');
  const digitalSource = String(exifrData?.digitalSourceType || exifrData?.DigitalSourceType || '');

  if (!result.isAi) {
    if (/dall[·\- ]*e/i.test(software) || /dall[·\- ]*e/i.test(source)) {
      result.isAi = true;
      result.ai.isAi = true;
      result.ai.generator = 'DALL·E 3 (OpenAI)';
      result.ai.confidence = 'high';
      result.ai.rawSource = 'EXIF Software / Credit';
    } else if (/firefly/i.test(software) || /firefly/i.test(source)) {
      result.isAi = true;
      result.ai.isAi = true;
      result.ai.generator = 'Adobe Firefly';
      result.ai.confidence = 'high';
      result.ai.rawSource = 'XMP / EXIF Software';
    } else if (/trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia/i.test(digitalSource)) {
      result.isAi = true;
      result.ai.isAi = true;
      result.ai.generator = 'AI Generated (C2PA / IPTC Certified)';
      result.ai.confidence = 'high';
      result.ai.rawSource = 'IPTC digitalSourceType: trainedAlgorithmicMedia';
      result.ai.details = 'Certified synthetic media marker found in Content Credentials / IPTC.';
    }
  }

  // 7. Check raw bytes scan as a fallback if arrayBuffer provided
  if (!result.isAi && arrayBuffer) {
    const rawSig = scanBufferForAiSignatures(arrayBuffer);
    if (rawSig) {
      result.isAi = true;
      result.ai.isAi = true;
      result.ai.generator = rawSig.generator;
      result.ai.confidence = 'medium';
      result.ai.rawSource = rawSig.standard;
      if (rawSig.note) result.ai.details = rawSig.note;
    }
  }

  // Formulate badge
  if (result.isAi) {
    result.badge = {
      title: result.ai.generator,
      description: result.ai.prompt ? `Prompt detected · Click to inspect` : `AI origin metadata found`,
      variant: 'ai'
    };
  } else if (result.privacy.hasGps) {
    result.badge = {
      title: `GPS Location Embedded`,
      description: `${result.privacy.formattedLocation} · ${result.camera.model || 'Camera'}`,
      variant: 'warning'
    };
  } else if (result.camera.isCamera) {
    const dev = [result.camera.make, result.camera.model].filter(Boolean).join(' ') || 'Digital Camera';
    result.badge = {
      title: `${dev}`,
      description: result.camera.exposure || 'Camera EXIF details available',
      variant: 'camera'
    };
  } else if (Object.keys(allFields).length > 0) {
    result.badge = {
      title: `${Object.keys(allFields).length} Metadata Fields`,
      description: 'Standard file & container tags',
      variant: 'standard'
    };
  } else {
    result.badge = {
      title: 'Clean / Stripped File',
      description: 'No EXIF or AI markers detected',
      variant: 'clean'
    };
  }

  return result;
}

/**
 * Video metadata analyzer for MediaInfo results
 */
export function analyzeVideoMetadata(file, fields = {}) {
  let hasGps = false;
  let lat = null;
  let lng = null;
  let formattedLocation = null;

  for (const [k, v] of Object.entries(fields)) {
    if (/gps|location|xyz/i.test(k)) {
      const match = String(v).match(/([+-]?\d+\.?\d*)[,/ ]+([+-]?\d+\.?\d*)/);
      if (match) {
        lat = parseFloat(match[1]);
        lng = parseFloat(match[2]);
        hasGps = true;
        formattedLocation = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        break;
      }
    }
  }

  const device = fields['General.Encoded_Application'] || fields['General.Writing_application'] || fields['General.com.apple.quicktime.model'] || '';
  const make = fields['General.com.apple.quicktime.make'] || '';
  const isApple = /apple|iphone|ipad/i.test(device) || /apple/i.test(make);
  const isAi = /runway|sora|pika|luma|kling|gen-2|gen-3/i.test(device);

  const result = {
    isAi,
    ai: {
      isAi,
      generator: isAi ? 'AI Generated Video' : '',
      confidence: isAi ? 'high' : 'none',
      prompt: '',
      negativePrompt: '',
      model: '',
      seed: '',
      sampler: '',
      steps: '',
      cfgScale: '',
      extraParams: {},
      rawSource: device,
      details: ''
    },
    camera: {
      isCamera: isApple || !!make,
      make: make || (isApple ? 'Apple' : ''),
      model: fields['General.com.apple.quicktime.model'] || (isApple ? 'Apple Device' : ''),
      lens: '',
      exposure: '',
      iso: '',
      aperture: '',
      shutter: '',
      focalLength: '',
      dateTime: fields['General.Recorded_Date'] || fields['General.Encoded_Date'] || '',
      software: device
    },
    privacy: {
      hasGps,
      latitude: lat,
      longitude: lng,
      formattedLocation,
      hasAuthor: !!fields['General.Performer'] || !!fields['General.Artist'],
      author: fields['General.Performer'] || fields['General.Artist'] || null,
      software: device
    },
    badge: {
      title: 'Video File',
      description: 'Media container',
      variant: 'standard'
    },
    allFields: fields
  };

  if (isAi) {
    result.badge = { title: 'AI Video Generator', description: device, variant: 'ai' };
  } else if (hasGps) {
    result.badge = { title: 'GPS Location Tagged', description: formattedLocation, variant: 'warning' };
  } else if (result.camera.isCamera) {
    result.badge = { title: `${result.camera.make} ${result.camera.model}`.trim() || 'Camera Video', description: 'Camera recording metadata', variant: 'camera' };
  } else if (Object.keys(fields).length > 0) {
    result.badge = { title: `${Object.keys(fields).length} Video Tags`, description: 'Track & container tags', variant: 'standard' };
  } else {
    result.badge = { title: 'Clean / Stripped Video', description: 'No extra tags detected', variant: 'clean' };
  }

  return result;
}
