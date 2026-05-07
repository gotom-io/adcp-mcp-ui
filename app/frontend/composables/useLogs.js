const { ref, computed } = Vue;
import { ERROR_KEYWORDS, HIGHLIGHT_KEYWORDS } from '../constants.js';

export function useLogs(authToken, mcpServer, aiModel, mcpSessionId, loading, error) {
  const showLogs = ref(false);
  const logs = ref('');
  const logFilter = ref('');
  const logSearchQuery = ref(mcpSessionId);

  const highlightedLogs = computed(() => {
    if (!logs.value) return '';

    let logsVal = Array.isArray(logs.value) ? logs.value : [];

    // filter
    if (logFilter.value.trim()) {
      const term = logFilter.value.trim().toLowerCase();
      logsVal = logsVal
        .filter(line => line.toLowerCase().includes(term))
        .join('\n');
    } else {
      logsVal = logsVal.join('\n');
    }

    // highlight keywords
    logsVal = logsVal
      .replace(new RegExp(`(${ERROR_KEY_WORDS})`, 'gi'), '<span class="log-error">$1</span>')
      .replace(new RegExp(`(${HIGHLIGHT_KEY_WORDS})`, 'gi'), '<span class="log-keyword">$1</span>');

    return logsVal;
  });

  const getRequestHeaders = () => ({
    'Content-Type': 'application/json',
    'x-adcp-auth': authToken.value,
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

      logs.value = data?.structuredContent || [];
      showLogs.value = true;

    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  };

  return {
    showLogs,
    logs,
    logFilter,
    logSearchQuery,
    highlightedLogs,
    closeLogs,
    searchLogs,
  };
}
