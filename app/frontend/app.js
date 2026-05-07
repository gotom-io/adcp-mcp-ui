import { getMcpSessionIdShort } from '/shared/session.mjs';
import {
  fetchSettings,
  saveSetting,
  buildAuthHeaders,
  searchLogs as apiSearchLogs,
  clearChatHistory,
  streamChat,
  consumeNdjsonStream,
} from './api-client.mjs';
import { buildHighlightedLogs } from './log-viewer.mjs';

const { createApp, ref, onMounted, nextTick, computed } = Vue;

const DEFAULT_AI_MODEL = 'anthropic:claude-sonnet-4-6';

createApp({
  setup() {
    // ---- Configuration / settings ----
    const authToken  = ref('');
    const aiModel    = ref(DEFAULT_AI_MODEL);
    const serverChoices = ref(window.chat_config.serverChoices);
    const mcpServer  = ref(serverChoices.value[0].url);

    // ---- Chat state ----
    const promptInput = ref('');
    const messages    = ref([]);
    const error       = ref('');
    const loading     = ref(false);
    const chatContainer = ref(null);
    const inputArea     = ref(null);

    // ---- Session ----
    const sessionId    = crypto.randomUUID();
    const mcpSessionId = getMcpSessionIdShort(sessionId);

    // ---- Logs panel ----
    const showLogs       = ref(false);
    const logs           = ref('');
    const logFilter      = ref('');
    const logSearchQuery = ref(mcpSessionId);

    const highlightedLogs = computed(() => buildHighlightedLogs(logs.value, logFilter.value));

    const getHeaders = () => buildAuthHeaders({
      authToken: authToken.value,
      mcpServer: mcpServer.value,
      aiModel:   aiModel.value,
      sessionId,
    });

    // ---- Settings persistence ----
    const saveCookie       = () => saveSetting('adcp_auth', authToken.value);
    const saveServerCookie = () => saveSetting('mcp_server', mcpServer.value);
    const saveModelCookie  = () => saveSetting('ai_model', aiModel.value);

    onMounted(async () => {
      try {
        const settings = await fetchSettings();
        if (settings.adcp_auth) authToken.value = settings.adcp_auth;
        if (settings.mcp_server?.trim()) mcpServer.value = settings.mcp_server;
        if (settings.ai_model) aiModel.value = settings.ai_model;
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    });

    // ---- UI helpers ----
    const scrollToBottom = async () => {
      await nextTick();
      if (chatContainer.value) {
        chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
      }
    };

    const adjustTextareaHeight = () => {
      const el = inputArea.value;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    };

    const renderMarkdown = (text) => (text ? marked.parse(text) : '');

    const handleKeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    };

    // ---- Logs panel actions ----
    const closeLogs = () => { showLogs.value = false; };

    const searchLogs = async () => {
      if (loading.value) return;
      error.value = '';
      loading.value = true;
      try {
        const data = await apiSearchLogs(getHeaders(), logSearchQuery.value.trim());
        logs.value = data?.structuredContent || [];
        showLogs.value = true;
      } catch (err) {
        error.value = err.message;
      } finally {
        loading.value = false;
      }
    };

    // ---- Chat actions ----
    const clearHistory = async () => {
      if (loading.value) return;
      try {
        await clearChatHistory(getHeaders());
        messages.value = [];
        error.value = '';
      } catch (err) {
        error.value = 'Failed to clear history: ' + err.message;
      }
    };

    const handleStreamPart = (data, getAssistantIndex) => {
      if (data.type === 'text-delta' && data.text) {
        const index = getAssistantIndex();
        messages.value[index].content += data.text;
        scrollToBottom();
      } else if (data.type === 'context-truncated') {
        messages.value.push({ role: 'warning', content: data.message });
        scrollToBottom();
      } else if (data.type === 'error') {
        error.value = data.error;
        scrollToBottom();
      }
    };

    const submit = async () => {
      const text = promptInput.value.trim();
      if (!text || loading.value) return;

      if (!authToken.value) {
        error.value = 'Please enter an API key in the sidebar before sending a message.';
        return;
      }

      messages.value.push({ role: 'user', content: text });
      promptInput.value = '';
      adjustTextareaHeight();
      error.value = '';
      loading.value = true;
      scrollToBottom();

      let assistantMsgIndex = null;
      const getAssistantIndex = () => {
        if (assistantMsgIndex === null) {
          assistantMsgIndex = messages.value.length;
          messages.value.push({ role: 'assistant', content: '' });
        }
        return assistantMsgIndex;
      };

      try {
        const response = await streamChat(getHeaders(), text);
        await consumeNdjsonStream(response, (data) => handleStreamPart(data, getAssistantIndex));
      } catch (err) {
        error.value = err.message;
        scrollToBottom();
      } finally {
        loading.value = false;
      }
    };

    return {
      // settings
      authToken, mcpServer, aiModel, serverChoices,
      saveCookie, saveServerCookie, saveModelCookie,
      // chat
      promptInput, messages, error, loading,
      chatContainer, inputArea,
      submit, handleKeydown, clearHistory,
      adjustTextareaHeight, renderMarkdown,
      // logs
      showLogs, closeLogs, logFilter, logSearchQuery,
      searchLogs, highlightedLogs,
      // session
      mcpSessionId,
    };
  },
}).mount('#app');
