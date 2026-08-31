import { getMcpSessionIdShort } from "./shared.mjs";

const { createApp, ref, onMounted, nextTick, computed } = Vue;

createApp({
  setup() {
    const authToken = ref('');
    const signingPassword = ref('');
    const aiModel = ref('anthropic:claude-sonnet-5');
    const promptInput = ref('');
    const messages = ref([]);
    const error = ref('');
    const loading = ref(false);
    const chatContainer = ref(null);
    const inputArea = ref(null);
    const serverChoices = ref(window.chat_config.serverChoices);
    const mcpServer = ref(serverChoices.value[0].url);
    // Server-injected: true when the backend holds an RFC 9421 signing key —
    // an empty API-key field then means "signature-only session".
    const signingEnabled = ref(window.chat_config?.signingEnabled === true);
    // Customer mode (GOT-12664): a customer API key locks the sidebar down —
    // only the key's own environments, a pinned model, no signing password,
    // no logs, no session id. The server enforces all of it independently.
    const customerMode = ref(window.chat_config?.customerMode === true);
    if (customerMode.value && window.chat_config.aiModel) {
      aiModel.value = window.chat_config.aiModel;
    }
    console.log("window.chat_config", window.chat_config);
    const showLogs = ref(false);
    const sidebarCollapsed = ref(false);
    const logs = ref('');
    const logFilter = ref('');
    const sessionId = crypto.randomUUID();
    const mcpSessionId = getMcpSessionIdShort(sessionId);
    const logSearchQuery = ref(mcpSessionId);
    // Generate unique session ID for this browser tab

    const highlightedLogs = computed(() => {
      if (!logs.value) return '';

      let logsVal = Array.isArray(logs.value) ? logs.value : []; //e.g. ['row1 blabla', 'row2 blabla']

      // filter
      if (logFilter.value.trim()) {
        const term = logFilter.value.trim().toLowerCase();
        console.error("term", term);

        logsVal = logsVal
            .filter(line => line.toLowerCase().includes(term))
            .join('\n');
      }else{
        logsVal = logsVal.join('\n');
      }

      const errorKeywords =
          'error|warning|critical|fatal|fail|failed|failure|missing|required|not found|undefined|none|denied|refused|rejected|blocked|invalid|illegal|bad|wrong|corrupt|corrupted|broken|crash|crashed|abort|aborted|killed|segfault|panic|exception|traceback|timeout|expired|exceeded|overflow|underflow|leak|deadlock|conflict|duplicate|mismatch|unknown|unexpected|unauthorized|forbidden|unavailable|unreachable|disconnected|lost|dropped|skipped|ignored|deprecated|obsolete|insecure|vulnerable|violation|permission|readonly|locked|busy|empty|stopped|suspended|terminated|exit|quit';

      const keywords =
          'askAi|Sending to|Executing tool|Tool executed|account_id|success';

      // highlight keywords
      logsVal = logsVal
          .replace(new RegExp(`(${errorKeywords})`, 'gi'), '<span class="log-error">$1</span>')
          .replace(new RegExp(`(${keywords})`, 'gi'), '<span class="log-keyword">$1</span>');

      return logsVal;
    });

    // Save a single setting via API (sets HttpOnly cookie on server)
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

    // Re-read the chat config for the current key: switches customer mode on
    // and off live while the key is being typed/pasted.
    const applyProfile = (profile) => {
      customerMode.value = profile.customerMode === true;
      signingEnabled.value = profile.signingEnabled === true;
      serverChoices.value = profile.serverChoices;
      if (!serverChoices.value.some(server => server.url === mcpServer.value)) {
        mcpServer.value = serverChoices.value[0].url;
      }
      if (customerMode.value && profile.aiModel) {
        aiModel.value = profile.aiModel;
      }
    };

    const refreshProfile = async () => {
      try {
        const res = await fetch('/api/profile');
        applyProfile(await res.json());
      } catch (err) {
        console.error('Failed to load profile:', err);
      }
    };

    const saveCookie = async () => {
      // The profile depends on the key, so refresh only after the cookie landed.
      await saveSetting('adcp_auth', authToken.value);
      await refreshProfile();
    };
    const saveServerCookie = () => saveSetting('mcp_server', mcpServer.value);
    const saveModelCookie = () => saveSetting('ai_model', aiModel.value);
    const saveSigningPasswordCookie = () => saveSetting('signing_password', signingPassword.value);

    // Load settings from server on mount
    onMounted(async () => {
      try {
        const res = await fetch('/api/settings');
        const settings = await res.json();
        if (settings.adcp_auth) {
          authToken.value = settings.adcp_auth;
        }
        // Only override mcpServer if a valid saved value exists — and never
        // with a server the current (customer) choices don't offer.
        if (settings.mcp_server && settings.mcp_server.trim()
            && serverChoices.value.some(server => server.url === settings.mcp_server)) {
          mcpServer.value = settings.mcp_server;
        }
        // A cookie may still hold a retired non-Anthropic model (e.g. openai:*);
        // ignore it so the select doesn't end up on a value it no longer offers.
        // In customer mode the model is pinned server-side — the cookie loses.
        if (!customerMode.value && settings.ai_model && settings.ai_model.startsWith('anthropic:')) {
          aiModel.value = settings.ai_model;
        }
        if (settings.signing_password) {
          signingPassword.value = settings.signing_password;
        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    });

    const scrollToBottom = async () => {
      await nextTick();
      if (chatContainer.value) {
        chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
      }
    };

    const adjustTextareaHeight = () => {
      const el = inputArea.value;
      if (el) {
        el.style.height = 'auto';
        el.style.height = (el.scrollHeight) + 'px';
      }
    };

    // The chat is a single long-lived page holding the whole conversation, so a
    // link that navigates in place (the campaign confirmation page the seller
    // returns, for one) would throw the session away. marked has no option for
    // this, so wrap its own link renderer rather than reimplementing it — that
    // keeps escaping and title handling wherever the CDN version puts them.
    const newTabRenderer = new marked.Renderer();
    const renderLink = newTabRenderer.link.bind(newTabRenderer);
    newTabRenderer.link = (...args) =>
      renderLink(...args).replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');

    const renderMarkdown = (text) => {
      if (!text) return '';
      return marked.parse(text, { renderer: newTabRenderer });
    };

    const handleKeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    };

    const getRequestHeaders = () => ({
      'Content-Type': 'application/json',
      // Omit the auth header entirely when the field is empty — with RFC
      // 9421 signing configured server-side, the request is then
      // authenticated purely via the request signature. Signature-only
      // sessions require the signing password (checked server-side; the
      // signing key must not be usable by anonymous visitors).
      ...(authToken.value ? { 'x-adcp-auth': authToken.value } : {}),
      ...(!authToken.value && signingPassword.value ? { 'x-signing-password': signingPassword.value } : {}),
      'x-mcp-server': mcpServer.value,
      'x-ai-model': aiModel.value,
      'x-session-id': sessionId,
    });

    const closeLogs = () => {
      showLogs.value = false;
    };
    const searchLogs = async () => {
      if (loading.value) return;

      error.value = '';
      loading.value = true;

      try {
        const params = new URLSearchParams({
          query: logSearchQuery.value.trim()
        });

        const res = await fetch(`/api/logs?${params.toString()}`, {
          method: 'GET',
          headers: getRequestHeaders()
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to search logs');
        }

        logs.value = data?.structuredContent || data?.content.map((o) => o.text) || [];
        showLogs.value = true;

      } catch (err) {
        error.value = err.message;
      } finally {
        loading.value = false;
      }
    };
    const clearHistory = async () => {
      if (loading.value) return;
      
      try {
        await fetch('/api/chat', {
          method: 'POST',
          headers: getRequestHeaders(),
          body: JSON.stringify({ clearHistory: true })
        });
        messages.value = [];
        error.value = '';
      } catch (err) {
        error.value = 'Failed to clear history: ' + err.message;
      }
    };

    const submit = async () => {
      const text = promptInput.value.trim();
      if (!text || loading.value) return;
      
      // An empty API key is only valid when the server signs requests
      // (RFC 9421 signature-only session) AND the user presents the signing
      // password — the signing key must not be usable anonymously.
      if (!authToken.value && !(signingEnabled.value && signingPassword.value)) {
        error.value = signingEnabled.value
          ? 'Enter an API key OR the signing password in the sidebar before sending a message.'
          : 'Please enter an API key in the sidebar before sending a message.';
        return;
      }
      
      messages.value.push({ role: 'user', content: text });
      promptInput.value = '';
      adjustTextareaHeight();
      error.value = '';
      loading.value = true;
      scrollToBottom();
      
      let assistantMsgIndex = null;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: getRequestHeaders(),
          body: JSON.stringify({ prompt: text })
        });

        if (!res.ok) {
          const errText = await res.text();
          try {
            const json = JSON.parse(errText);
            throw new Error(json.error || `Request failed with status ${res.status}`);
          } catch (e) {
            throw new Error(errText || `Request failed with status ${res.status}`);
          }
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(Boolean);
          
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.type === 'text-delta' && data.text) {
                if (assistantMsgIndex === null) {
                  assistantMsgIndex = messages.value.length;
                  messages.value.push({ role: 'assistant', content: '' });
                }
                messages.value[assistantMsgIndex].content += data.text;
                scrollToBottom();
              } else if (data.type === 'context-truncated') {
                messages.value.push({ role: 'warning', content: data.message });
                scrollToBottom();
              } else if (data.type === 'error') {
                error.value = data.error;
                scrollToBottom();
              }
            } catch (e) {
              // Partial chunk or parse error
            }
          }
        }
      } catch (err) {
        error.value = err.message;
        scrollToBottom();
      } finally {
        loading.value = false;
      }
    };

    return {
      authToken,
      signingPassword,
      signingEnabled,
      customerMode,
      mcpServer,
      aiModel,
      promptInput,
      messages,
      error,
      loading,
      saveCookie,
      saveServerCookie,
      saveModelCookie,
      saveSigningPasswordCookie,
      submit,
      handleKeydown,
      clearHistory,
      chatContainer,
      inputArea,
      adjustTextareaHeight,
      renderMarkdown,
      serverChoices,
      highlightedLogs,
      showLogs,
      closeLogs,
      logFilter,
      logSearchQuery,
      searchLogs,
      mcpSessionId,
      sidebarCollapsed,
    };
  }
}).mount('#app');
