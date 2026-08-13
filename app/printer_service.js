/**
 * Prince Picker Thermal Printer Service
 */
(function(window) {
  let activeDriver = null;

  // Simple WebPrintDriver: Browser-native print dialog (works offline and on Android System Print)
  const WebPrintDriver = {
    getStatus: function() { return 'connected'; },
    connect: async function() { return true; },
    disconnect: async function() { return true; },
    print: async function(canvases, options = {}) {
      return new Promise((resolve, reject) => {
        try {
          const widthMm = options.widthMm || 30;
          const heightMm = options.heightMm || 20;

          const imgs = canvases.map(c => c.toDataURL('image/png'));
          const wMM = widthMm + 'mm';
          const hMM = heightMm + 'mm';
          
          const labelDivs = imgs.map(src => `<div class="lbl"><img src="${src}"></div>`).join('');
          const printHtml = [
            '<!DOCTYPE html><html><head><meta charset="utf-8">',
            '<style>',
            '@page { size: ' + wMM + ' ' + hMM + '; margin: 0; }',
            'html, body { margin: 0; padding: 0; }',
            '.lbl { width: ' + wMM + '; height: ' + hMM + '; display: block; page-break-after: always; overflow: hidden; }',
            '.lbl img { width: 100%; height: 100%; display: block; }',
            '</style></head><body>',
            labelDivs,
            '</body></html>'
          ].join('');

          const blob = new Blob([printHtml], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          
          // Inject standard hidden print iframe
          const fr = document.createElement('iframe');
          fr.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px';
          fr.src = url;
          fr.onload = function() {
            try {
              fr.contentWindow.focus();
              fr.contentWindow.print();
              resolve({ success: true, method: 'browser_iframe' });
            } catch (e) {
              reject(new Error(`Print frame block: ${e.message}`));
            } finally {
              setTimeout(function() {
                if (fr.parentNode) document.body.removeChild(fr);
                URL.revokeObjectURL(url);
              }, 6000);
            }
          };
          document.body.appendChild(fr);
        } catch (err) {
          reject(err);
        }
      });
    }
  };

  const PrinterService = {
    getStatus: function() {
      if (activeDriver) return activeDriver.getStatus();
      return 'disconnected';
    },

    connect: async function(options = {}) {
      const driverType = options.driver || localStorage.getItem('printer_driver_type') || 'none';
      console.log('[PrinterService] Connecting to driver:', driverType);

      if (driverType === 'none') {
        activeDriver = null;
        throw new Error('Printer driver not configured');
      }

      if (driverType === 'webprint') {
        activeDriver = WebPrintDriver;
        return true;
      }

      // If user configures hardware specific drivers (escpos, tspl, native) but they aren't implemented/paired:
      activeDriver = null;
      throw new Error(`Printer driver not configured: Driver "${driverType}" is currently unavailable (no active IPC bridge)`);
    },

    disconnect: async function() {
      if (activeDriver && typeof activeDriver.disconnect === 'function') {
        await activeDriver.disconnect();
      }
      activeDriver = null;
      console.log('[PrinterService] Disconnected');
    },

    printLabels: async function(labelCanvases, options = {}) {
      if (!Array.isArray(labelCanvases) || labelCanvases.length === 0) {
        throw new Error('No label canvas data provided to print');
      }

      // Read configured driver type (default to webprint if not set)
      const driverType = localStorage.getItem('printer_driver_type') || 'webprint';

      if (driverType === 'webprint') {
        return await WebPrintDriver.print(labelCanvases, options);
      }

      // If configured driver is not webprint and not connected/initialized
      if (!activeDriver) {
        try {
          await this.connect({ driver: driverType });
        } catch (e) {
          throw new Error('Printer driver not configured: ' + e.message);
        }
      }

      if (!activeDriver) {
        throw new Error('Printer driver not configured');
      }

      return await activeDriver.print(labelCanvases, options);
    }
  };

  window.PRINTER_SERVICE = PrinterService;
})(typeof window !== 'undefined' ? window : this);
