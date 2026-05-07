import { getMcpSessionIdShort } from '../shared/shared.mjs';

const { createApp, ref, onMounted, nextTick, computed } = Vue;

const sessionId = crypto.randomUUID();
const mcpSessionId = getMcpSessionIdShort(sessionId);

createApp({
  setup() {
    const authToken     = ref('');
    const aiModel       = ref('anthropic:claude-sonnet-4-6');
    const mcpServer     = ref(window.chat_config.serverChoices?.[0]?.url || '');
    const promptInput   = ref('');
    const messages      = ref([]);
    const error         = ref('');
    const loading       = ref(false);
    const chatContainer = ref(null);
    const inputArea     = ref(null);
    const showLogs      = ref(false);
    const logs          = ref([]);
    const logFilter     = ref('');
    const logSearchQuery = ref(mcpSessionId);

    // --- Log highlighting ---
    const errorRe = /error|warning|critical|fatal|fail|failed|missing|required|not found|undefined|denied|refused|rejected|blocked|invalid|illegal|corrupt|crash|crashed|abort|aborted|panic|exception|traceback|timeout|expired|leak|deadlock|conflict|duplicate|mismatch|unknown|unexpected|unauthorized|forbidden|unavailable|disconnected|lost|dropped|skipped|ignored|deprecated|insecure|violation|permission|readonly|locked|empty|stopped|terminated|exit/i;
    const keywordRe = /askAi|Sending to|Executing tool|Tool executed|account_id|success/i;

    const highlightedLogs = computed(() => {
      if (!logs.value) return '';
      let text = logs.value.join('\n');
      if (logFilter.value.trim()) {
        const term = logFilter.value.trim().toLowerCase();
        text = logs.value.filter(l => l.toLowerCase().includes(term)).join('\n');
      }
      return text
        .replace(errorRe, '<span class="log-error">$&</span>')
        .replace(keywordRe, '<span class="log-keyword">$&</span>');
    });

    // --- Settings ---
    const saveSetting = async (name, value) => {
      try { await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [name]: value }) }); }
      catch { /* silent */ }
    };
    const saveCookie   = () => saveSetting('adcp_auth', authToken.value);
    const saveServer   = () => saveSetting('mcp_server', mcpServer.value);
    const saveModel    = () => saveSetting('ai_model', aiModel.value);

    onMounted(async () => {
      try {
        const { adcp_auth, mcp_server, ai_model } = await (await fetch('/api/settings')).json();
        if (adcp_auth)   authToken.value = adcp_auth;
        if (mcp_server)  mcpServer.value = mcp_server;
        if (ai_model)    aiModel.value   = ai_model;
      } catch { /* silent */ }
    });

    // --- Helpers ---
    const scrollToBottom = () => nextTick(() => {
      if (chatContainer.value) chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    });

    const adjustTextarea = () => {
      if (inputArea.value) { inputArea.value.style.height = 'auto'; inputArea.value.style.height = inputArea.value.scrollHeight + 'px'; }
    };

    const headers = () => ({
      'Content-Type': 'application/json',
      'x-adcp-auth': authToken.value,
      'x-mcp-server': mcpServer.value,
      'x-ai-model': aiModel.value,
      'x-session-id': sessionId,
    });

    // --- Actions ---
    const searchLogs = async () => {
      if (loading.value) return;
      error.value = ''; loading.value = true;
      try {
        const res = await fetch(`/api/logs?query=${encodeURIComponent(logSearchQuery.value.trim())}`, { headers: headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to search logs');
        logs.value = data.structuredContent || [];
        showLogs.value = true;
      } catch (err) { error.value = err.message; }
      finally { loading.value = false; }
    };

    const clearHistory = async () => {
      if (loading.value) return;
      try {
        await fetch('/api/chat', { method: 'POST', headers: headers(), body: JSON.stringify({ clearHistory: true }) });
        messages.value = []; error.value = '';
      } catch (err) { error.value = 'Failed to clear history: ' + err.message; }
    };

    const submit = async () => {
      const text = promptInput.value.trim();
      if (!text || loading.value) return;
      if (!authToken.value) { error.value = 'Please enter an API key in the sidebar before sending a message.'; return; }

      messages.value.push({ role: 'user', content: text });
      promptInput.value = ''; adjustTextarea(); error.value = ''; loading.value = true;
      scrollToBottom();

      let assistantIdx = null;
      try {
        const res = await fetch('/api/chat', { method: 'POST', headers: headers(), body: JSON.stringify({ prompt: text }) });
        if (!res.ok) {
          const t = await res.text();
          try { throw new Error(JSON.parse(t).error || `Status ${res.status}`); }
          catch { throw new Error(t || `Status ${res.status}`); }
        }

        const reader = res.body.getReader(), decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value, { stream: true }).split('\n').filter(Boolean)) {
            try {
              const data = JSON.parse(line);
              if (data.type === 'text-delta' && data.text) {
                if (assistantIdx === null) { assistantIdx = messages.value.length; messages.value.push({ role: 'assistant', content: '' }); }
                messages.value[assistantIdx].content += data.text;
                scrollToBottom();
              } else if (data.type === 'context-truncated') {
                messages.value.push({ role: 'warning', content: data.message });
                scrollToBottom();
              } else if (data.type === 'error') {
                error.value = data.error;
                scrollToBottom();
              }
            } catch { /* partial chunk */ }
          }
        }
      } catch (err) { error.value = err.message; scrollToBottom(); }
      finally { loading.value = false; }
    };

    return {
      authToken, mcpServer, aiModel, promptInput, messages, error, loading,
      chatContainer, inputArea, saveCookie, saveServer, saveModel,
      submit, handleKeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } },
      clearHistory, adjustTextareaHeight: adjustTextarea, renderMarkdown: (t) => t ? marked.parse(t) : '',
      serverChoices: ref(window.chat_config.serverChoices),
      highlightedLogs, showLogs, closeLogs: () => { showLogs.value = false; },
      logFilter, logSearchQuery, searchLogs, mcpSessionId,
    };
  }
}).mount('#app');
