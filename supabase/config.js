/**
 * Supabase Configuration for Prince Picker
 */
(function(window) {
  const defaultConfig = {
    url: 'https://jzwpbiqiplsuuukbxhnq.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6d3BiaXFpcGxzdXV1a2J4aG5xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4NjQzNDcsImV4cCI6MjEwMDQ0MDM0N30.-Sxvmx1hsz3P64GKS_77T2iGDTYj5ysMtQZxw1vdtM0',
  };

  const storedUrl = localStorage.getItem('sp_project_url');
  const storedKey = localStorage.getItem('sp_anon_key');

  window.SUPABASE_CONFIG = {
    url: storedUrl || defaultConfig.url,
    anonKey: storedKey || defaultConfig.anonKey,
    updateConfig: function(url, key) {
      if (url) localStorage.setItem('sp_project_url', url);
      if (key) localStorage.setItem('sp_anon_key', key);
      window.SUPABASE_CONFIG.url = url || window.SUPABASE_CONFIG.url;
      window.SUPABASE_CONFIG.anonKey = key || window.SUPABASE_CONFIG.anonKey;
    }
  };
})(typeof window !== 'undefined' ? window : this);
