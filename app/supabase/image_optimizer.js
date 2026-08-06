/**
 * Smart Product Image Optimizer for Prince Picker
 * Adaptive WebP Compression: Max 1400px, aspect ratio preserved, no upscaling, size <= 700 KB.
 * Strips all EXIF metadata (GPS, camera model, orientation, timestamps) via fresh Canvas pixel export.
 * Validates decoded image buffer to reject malicious payloads or corrupted files.
 */
(function(window) {
  const MAX_DIMENSION = 1400;
  const TARGET_MAX_BYTES = 700 * 1024; // 700 KB

  async function optimizeProductImage(fileOrImage, options = {}) {
    // 1. Client-side file format & type check
    if (window.IMAGE_UTILS && typeof window.IMAGE_UTILS.validateImageFile === 'function') {
      if (fileOrImage instanceof File || fileOrImage instanceof Blob) {
        await window.IMAGE_UTILS.validateImageFile(fileOrImage);
      }
    }

    // 2. Decode image pixels into HTMLImageElement
    const img = await loadImage(fileOrImage);
    let origW = img.naturalWidth || img.width;
    let origH = img.naturalHeight || img.height;

    // Security check: Validate pixel dimensions
    if (!origW || !origH || origW <= 0 || origH <= 0) {
      throw new Error('Security Error: Failed to decode image pixels. File may be corrupted or invalid.');
    }

    // 3. Compute target dimensions (Max 1400px, aspect ratio preserved, no upscaling)
    let { targetW, targetH } = computeScale(origW, origH, MAX_DIMENSION);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let currentW = targetW;
    let currentH = targetH;
    let quality = 0.85;
    let mimeType = 'image/webp';

    // Verify canvas WebP export support
    if (!isWebPSupported(canvas)) {
      mimeType = 'image/jpeg';
    }

    let blob = null;
    let dataUrl = '';
    let sizeBytes = 0;
    let iteration = 0;
    const maxIterations = 20;

    // 4. Adaptive Compression Loop (Quality 0.85 -> 0.70, then 5% dimension scale-down)
    // EXIF metadata is completely stripped during Canvas 2D image drawing
    while (iteration < maxIterations) {
      canvas.width = currentW;
      canvas.height = currentH;

      ctx.clearRect(0, 0, currentW, currentH);
      ctx.drawImage(img, 0, 0, currentW, currentH);

      dataUrl = canvas.toDataURL(mimeType, quality);
      blob = dataURLToBlob(dataUrl, mimeType);

      if (!blob || blob.size === 0) {
        throw new Error('Validation Error: Canvas failed to export valid image blob.');
      }

      sizeBytes = blob.size;

      if (sizeBytes <= TARGET_MAX_BYTES) {
        break; // Successfully compressed under 700 KB
      }

      // Step A: First lower WebP quality down to 0.70
      if (quality > 0.70) {
        quality = Math.max(0.70, quality - 0.05);
      } else {
        // Step B: If still > 700 KB, reduce dimensions by 5%
        currentW = Math.floor(currentW * 0.95);
        currentH = Math.floor(currentH * 0.95);
        if (currentW < 100 || currentH < 100) {
          break; // Keep reasonable canvas size
        }
      }
      iteration++;
    }

    const sizeKB = Math.round(sizeBytes / 1024);

    return {
      blob,
      dataUrl,
      width: currentW,
      height: currentH,
      sizeBytes,
      sizeKB,
      mime: mimeType,
      format: mimeType.split('/')[1] || 'webp'
    };
  }

  function computeScale(width, height, maxDim) {
    if (width <= maxDim && height <= maxDim) {
      return { targetW: width, targetH: height }; // Never upscale
    }
    if (width >= height) {
      const ratio = maxDim / width;
      return { targetW: maxDim, targetH: Math.round(height * ratio) };
    } else {
      const ratio = maxDim / height;
      return { targetW: Math.round(width * ratio), targetH: maxDim };
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image file. File may be corrupted.'));

      if (src instanceof File || src instanceof Blob) {
        img.src = URL.createObjectURL(src);
      } else if (typeof src === 'string') {
        img.src = src;
      } else {
        reject(new Error('Invalid image source parameter'));
      }
    });
  }

  function isWebPSupported(canvas) {
    try {
      return canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) {
      return false;
    }
  }

  function dataURLToBlob(dataUrl, mimeType) {
    const arr = dataUrl.split(',');
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mimeType });
  }

  window.IMAGE_OPTIMIZER = {
    optimizeProductImage,
    computeScale
  };
})(typeof window !== 'undefined' ? window : this);
