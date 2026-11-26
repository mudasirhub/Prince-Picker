/**
 * Supabase Authentication, Picker Verification & Biometric Fingerprint Support
 */
(function(window) {
  const LS_BIOMETRIC_CRED = 'pa_biometric_cred';
  const LS_BIOMETRIC_LOCK = 'pa_biometric_lock';

  function uint8ToBase64Url(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.byteLength; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToUint8(base64Url) {
    const pad = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const b64 = (base64Url + pad).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function randomBytes(length) {
    const arr = new Uint8Array(length);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }

  function getCapacitorBiometricPlugin() {
    try {
      const plugins = window.Capacitor && window.Capacitor.Plugins;
      if (!plugins) return null;
      if (plugins.NativeBiometric && typeof plugins.NativeBiometric.verifyIdentity === 'function') {
        return { name: 'NativeBiometric', plugin: plugins.NativeBiometric };
      }
      if (plugins.BiometricAuth && typeof plugins.BiometricAuth.authenticate === 'function') {
        return { name: 'BiometricAuth', plugin: plugins.BiometricAuth };
      }
    } catch (_) { }
    return null;
  }

  async function isBiometricSupported() {
    const capPlugin = getCapacitorBiometricPlugin();
    if (capPlugin) {
      try {
        if (typeof capPlugin.plugin.isAvailable === 'function') {
          const res = await capPlugin.plugin.isAvailable();
          if (res && res.isAvailable !== false) {
            return { supported: true, mode: 'capacitor' };
          }
        } else {
          return { supported: true, mode: 'capacitor' };
        }
      } catch (_) { }
    }

    const isSecure = typeof window !== 'undefined' && (window.isSecureContext || window.location?.hostname === 'localhost');
    if (
      isSecure &&
      typeof window.PublicKeyCredential !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function'
    ) {
      try {
        if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
          const avail = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          if (avail) return { supported: true, mode: 'webauthn' };
        } else {
          return { supported: true, mode: 'webauthn' };
        }
      } catch (_) { }
    }

    return { supported: false, mode: 'none' };
  }

  function getBiometricEnrollment() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_BIOMETRIC_CRED) : null;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.pickerName) return null;
      if (parsed.mode !== 'capacitor' && !parsed.credIdBase64Url) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function isBiometricLockEnabled() {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(LS_BIOMETRIC_LOCK) === 'true' && !!getBiometricEnrollment();
    } catch (_) {
      return false;
    }
  }

  function setBiometricLockEnabled(enabled) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_BIOMETRIC_LOCK, enabled ? 'true' : 'false');
      }
    } catch (_) { }
  }

  async function clearBiometric() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(LS_BIOMETRIC_CRED);
        localStorage.removeItem(LS_BIOMETRIC_LOCK);
      }
      if (window.PICKER_DB && typeof window.PICKER_DB.setMeta === 'function') {
        await window.PICKER_DB.setMeta('biometricEnrollment', null);
      }
    } catch (_) { }
  }

  async function runCapacitorBiometricPrompt(capPlugin, reason) {
    if (capPlugin.name === 'NativeBiometric') {
      await capPlugin.plugin.verifyIdentity({
        reason: reason || 'Verify your fingerprint to continue',
        title: 'Prince Picker Biometric Auth',
        subtitle: 'Fingerprint Authentication',
        description: 'Place your finger on the sensor'
      });
      return true;
    }
    await capPlugin.plugin.authenticate({
      reason: reason || 'Verify your fingerprint to continue',
      allowDeviceCredential: true
    });
    return true;
  }

  async function enrollBiometric(pickerName, pickerId, role) {
    const cleanName = String(pickerName || '').trim();
    if (!cleanName) {
      return { success: false, error: 'Log in as a picker before enabling fingerprint.' };
    }

    const support = await isBiometricSupported();
    if (!support.supported) {
      return { success: false, error: 'Fingerprint / biometric authentication is not available on this device or browser.' };
    }

    const cleanId = String(pickerId || (typeof localStorage !== 'undefined' ? localStorage.getItem('picker_id') : '') || ('P-' + Date.now()));
    const cleanRole = String(role || (typeof localStorage !== 'undefined' ? localStorage.getItem('pa_role') : '') || 'picker');

    try {
      let enrollment = {
        pickerName: cleanName,
        pickerId: cleanId,
        role: cleanRole,
        mode: support.mode,
        createdAt: new Date().toISOString()
      };

      if (support.mode === 'capacitor') {
        const capPlugin = getCapacitorBiometricPlugin();
        await runCapacitorBiometricPrompt(capPlugin, `Enable fingerprint login for ${cleanName}`);
      } else {
        const rpId = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'localhost';
        const userIdBytes = new TextEncoder().encode(cleanId).slice(0, 64);
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge: randomBytes(32),
            rp: { name: 'Prince Picker', id: rpId },
            user: {
              id: userIdBytes.length > 0 ? userIdBytes : randomBytes(16),
              name: cleanName,
              displayName: cleanName
            },
            pubKeyCredParams: [
              { alg: -7, type: 'public-key' },
              { alg: -257, type: 'public-key' }
            ],
            authenticatorSelection: {
              authenticatorAttachment: 'platform',
              userVerification: 'required',
              residentKey: 'preferred'
            },
            timeout: 60000,
            attestation: 'none'
          }
        });
        if (!credential || !credential.rawId) {
          return { success: false, error: 'Fingerprint registration was not completed.' };
        }
        enrollment.credIdBase64Url = uint8ToBase64Url(credential.rawId);
      }

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_BIOMETRIC_CRED, JSON.stringify(enrollment));
      }
      if (window.PICKER_DB && typeof window.PICKER_DB.setMeta === 'function') {
        await window.PICKER_DB.setMeta('biometricEnrollment', enrollment);
      }
      return { success: true, enrollment };
    } catch (err) {
      const msg = (err && err.name === 'NotAllowedError')
        ? 'Fingerprint setup cancelled or timed out.'
        : (err?.message || 'Unable to register fingerprint.');
      return { success: false, error: msg };
    }
  }

  async function verifyBiometric() {
    const enrollment = getBiometricEnrollment();
    if (!enrollment) {
      return { success: false, error: 'Fingerprint is not enrolled on this device.' };
    }

    const support = await isBiometricSupported();
    if (!support.supported) {
      return { success: false, error: 'Biometric authentication unavailable in current context.' };
    }

    try {
      if (enrollment.mode === 'capacitor') {
        const capPlugin = getCapacitorBiometricPlugin();
        if (!capPlugin) {
          return { success: false, error: 'Native biometric plugin unavailable.' };
        }
        await runCapacitorBiometricPrompt(capPlugin, `Unlock Prince Picker as ${enrollment.pickerName}`);
      } else {
        const rpId = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'localhost';
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: randomBytes(32),
            rpId,
            allowCredentials: [
              {
                id: base64UrlToUint8(enrollment.credIdBase64Url),
                type: 'public-key',
                transports: ['internal']
              }
            ],
            userVerification: 'required',
            timeout: 60000
          }
        });
        if (!assertion) {
          return { success: false, error: 'Fingerprint verification failed.' };
        }
      }

      await savePickerLocally(enrollment.pickerName, enrollment.pickerId);
      return {
        success: true,
        biometric: true,
        picker: {
          name: enrollment.pickerName,
          id: enrollment.pickerId,
          role: enrollment.role || 'picker'
        }
      };
    } catch (err) {
      const msg = (err && err.name === 'NotAllowedError')
        ? 'Fingerprint verification cancelled or failed.'
        : (err?.message || 'Fingerprint verification failed.');
      return { success: false, error: msg };
    }
  }

  async function verifyPicker(pickerName, pickerPin) {
    if (!pickerName || !pickerName.trim()) {
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }
    if (!pickerPin || !pickerPin.trim()) {
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }

    const cleanName = pickerName.trim();
    const cleanPin = pickerPin.trim();

    // Verify 4-digit numeric format
    if (!/^\d{4}$/.test(cleanPin)) {
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;

    if (!client) {
      console.warn('[Auth] Supabase client not active.');
      return { success: false, error: 'Supabase connection offline. Verification unavailable.' };
    }

    try {
      // Call server-side PostgreSQL RPC function fn_verify_picker
      const { data, error } = await client.rpc('fn_verify_picker', {
        p_name: cleanName,
        p_pin: cleanPin
      });

      if (error) {
        console.warn('[Auth] Supabase RPC query error:', error.message);
        return { success: false, error: 'Invalid PIN. Access denied.' };
      }

      if (data && data.success && data.picker) {
        const picker = data.picker;
        const pickerId = picker.id || ('P-' + Math.floor(Math.random() * 10000));
        await savePickerLocally(picker.name || cleanName, pickerId);
        return {
          success: true,
          picker: {
            name: picker.name || cleanName,
            id: pickerId,
            role: picker.role || 'picker'
          }
        };
      } else {
        return {
          success: false,
          error: (data && data.error) ? data.error : 'Invalid PIN. Access denied.'
        };
      }
    } catch (e) {
      console.error('[Auth] Verification exception:', e);
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }
  }

  async function savePickerLocally(name, id) {
    let deviceId = localStorage.getItem('pa_device_id');
    if (!deviceId) {
      deviceId = 'DEV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      localStorage.setItem('pa_device_id', deviceId);
    }
    localStorage.setItem('pa_picker', name);
    localStorage.setItem('picker_id', id);

    if (window.PICKER_DB) {
      await window.PICKER_DB.setMeta('pickerName', name);
      await window.PICKER_DB.setMeta('pickerId', id);
      await window.PICKER_DB.setMeta('deviceId', deviceId);
    }
  }

  async function getSavedPicker() {
    if (window.PICKER_DB) {
      const name = await window.PICKER_DB.getMeta('pickerName');
      const id = await window.PICKER_DB.getMeta('pickerId');
      if (name) return { name, id: id || localStorage.getItem('picker_id') };
    }
    const name = localStorage.getItem('pa_picker');
    const id = localStorage.getItem('picker_id');
    return name ? { name, id } : null;
  }

  window.SUPABASE_AUTH = {
    verifyPicker,
    savePickerLocally,
    getSavedPicker,
    isBiometricSupported,
    getBiometricEnrollment,
    isBiometricLockEnabled,
    setBiometricLockEnabled,
    enrollBiometric,
    verifyBiometric,
    clearBiometric
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.SUPABASE_AUTH;
  }
})(typeof window !== 'undefined' ? window : globalThis);
