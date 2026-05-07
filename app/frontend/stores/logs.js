const { ref, computed } = Vue;
import { getMcpSessionIdShort } from '../../shared/shared.mjs';

export function useLogs(settings, chat) {
  const showLogs = ref(false);
  const logs = ref('');
  const logFilter = ref('');
  const logSearchQuery = ref(getMcpSessionIdShort(chat.sessionId));

  const highlightedLogs = computed(() => {
    if (!logs.value) return '';

    let logsVal = Array.isArray(logs.value) ? logs.value : [];

    if (logFilter.value.trim()) {
      const term = logFilter.value.trim().toLowerCase();

      logsVal = logsVal
          .filter(line => line.toLowerCase().includes(term))
          .join('\n');
    } else {
      logsVal = logsVal.join('\n');
    }

    const errorKeywords =
        'error|warning|critical|fatal|fail|failed|failure|missing|required|not found|undefined|none|denied|refused|rejected|blocked|invalid|illegal|bad|wrong|corrupt|corrupted|broken|crash|crashed|abort|aborted|killed|segfault|panic|exception|traceback|timeout|expired|exceeded|overflow|underflow|leak|deadlock|conflict|duplicate|mismatch|unknown|unexpected|unauthorized|forbidden|unavailable|unreachable|disconnected|lost|dropped|skipped|ignored|deprecated|obsolete|insecure|vulnerable|violation|permission|readonly|locked|busy|empty|stopped|suspended|terminated|exit|quit';

    const keywords =
        'askAi|Sending to|Executing tool|Tool executed|account_id|success';

    logsVal = logsVal
        .replace(new RegExp(`(${errorKeywords})`, 'gi'), '<span class="log-error">$1</span>')
        .replace(new RegExp(`(${keywords})`, 'gi'), '<span class="log-keyword">$1</span>');

    return logsVal;
  });

  const closeLogs = () => {
    showLogs.value = false;
  };

  const searchLogs = async () => {
    if (chat.loading.value) return;

    chat.error.value = '';
    chat.loading.value = true;

    try {
      const params = new URLSearchParams({
        query: logSearchQuery.value.trim()
      });

      const res = await fetch(`/api/logs?${params.toString()}`, {
        method: 'GET',
        headers: chat.getRequestHeaders()
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to search logs');
      }

      logs.value = data?.structuredContent || [];
      showLogs.value = true;

    } catch (err) {
      chat.error.value = err.message;
    } finally {
      chat.loading.value = false;
    }
  };

  return { showLogs, logs, logFilter, logSearchQuery, highlightedLogs, closeLogs, searchLogs };
}
