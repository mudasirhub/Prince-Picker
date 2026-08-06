/**
 * Image Utilities for Prince Picker: Validation, SHA-256 Deduplication, Drag-and-Drop
 */
(function(window) {
  async function validateImageFile(file) {
    if (!file) throw new Error('No file provided');
    if (!file.type || !file.type.startsWith('image/')) {
      throw new Error('Unsupported file format. Please select a valid image.');
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ valid: true, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Corrupted or invalid image file.'));
      };
      img.src = url;
    });
  }

  async function calculateChecksum(blobOrBuffer) {
    try {
      let buffer;
      if (blobOrBuffer instanceof ArrayBuffer) {
        buffer = blobOrBuffer;
      } else if (blobOrBuffer instanceof Blob || blobOrBuffer instanceof File) {
        buffer = await blobOrBuffer.arrayBuffer();
      } else if (typeof blobOrBuffer === 'string' && blobOrBuffer.startsWith('data:')) {
        const base64 = blobOrBuffer.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        buffer = bytes.buffer;
      } else {
        return null;
      }
      if (!window.crypto || !window.crypto.subtle) {
        return 'cs_' + Math.random().toString(36).substring(2, 12);
      }
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('[ImageUtils] Checksum error:', e);
      return 'cs_' + Date.now();
    }
  }

  function setupDragAndDrop(element, onDropFiles) {
    if (!element) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      element.addEventListener(eventName, e => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      element.addEventListener(eventName, () => {
        element.classList.add('drag-over');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      element.addEventListener(eventName, () => {
        element.classList.remove('drag-over');
      }, false);
    });

    element.addEventListener('drop', e => {
      const dt = e.dataTransfer;
      const files = dt ? dt.files : null;
      if (files && files.length > 0 && typeof onDropFiles === 'function') {
        onDropFiles(Array.from(files));
      }
    }, false);
  }

  window.IMAGE_UTILS = {
    validateImageFile,
    calculateChecksum,
    setupDragAndDrop
  };
})(typeof window !== 'undefined' ? window : this);
