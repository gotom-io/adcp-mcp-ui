const { createApp, ref, onMounted, nextTick, computed } = Vue;
import { getMcpSessionIdShort } from "../backend/shared.mjs";
import { useSettings } from "./composables/useSettings.js";
import { useChat } from "./composables/useChat.js";
import { useLogs } from "./composables/useLogs.js";
import { renderMarkdown } from "./helpers.js";

createApp({
  setup() {
    const sessionId = crypto.randomUUID();
    const mcpSessionId = getMcpSessionIdShort(sessionId);

    // Use composables
    const {
      authToken,
      aiModel,
      mcpServer,
      serverChoices,
      saveCookie,
      saveServerCookie,
      saveModelCookie,
    } = useSettings();

    const {
      promptInput,
      messages,
      error,
      loading,
      inputArea,
      chatContainer,
      submit,
      handleKeydown,
      clearHistory,
      scrollToBottom,
      adjustTextareaHeight,
    } = useChat(authToken, mcpServer, aiModel, sessionId);

    const {
      showLogs,
      logs,
      logFilter,
      logSearchQuery,
      highlightedLogs,
      closeLogs,
      searchLogs,
    } = useLogs(authToken, mcpServer, aiModel, mcpSessionId, loading, error);

    return {
      authToken,
      mcpServer,
      aiModel,
      promptInput,
      messages,
      error,
      loading,
      saveCookie,
      saveServerCookie,
      saveModelCookie,
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
    };
  }
}).mount('#app');
