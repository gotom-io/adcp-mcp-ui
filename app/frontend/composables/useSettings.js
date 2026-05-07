const { ref, onMounted } = Vue;

export function useSettings() {
  const authToken = ref('');
  const aiModel = ref('anthropic:claude-sonnet-4-6');
  const serverChoices = ref(window.chat_config.serverChoices);
  const mcpServer = ref(serverChoices.value[0].url);

  const saveSetting = async (name, value) => {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [name]: value }),
      });
    } catch (err) {
      console.error('Failed to save setting:', err);
    }
  };

  const saveCookie = () => saveSetting('adcp_auth', authToken.value);
  const saveServerCookie = () => saveSetting('mcp_server', mcpServer.value);
  const saveModelCookie = () => saveSetting('ai_model', aiModel.value);

  // Load settings from server on mount
  onMounted(async () => {
    try {
      const res = await fetch('/api/settings');
      const settings = await res.json();
      if (settings.adcp_auth) {
        authToken.value = settings.adcp_auth;
      }
      // Only override mcpServer if a valid saved value exists
      if (settings.mcp_server && settings.mcp_server.trim()) {
        mcpServer.value = settings.mcp_server;
      }
      if (settings.ai_model) {
        aiModel.value = settings.ai_model;
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  });

  return {
    authToken,
    aiModel,
    mcpServer,
    serverChoices,
    saveCookie,
    saveServerCookie,
    saveModelCookie,
  };
}
