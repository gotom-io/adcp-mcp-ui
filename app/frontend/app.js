const { createApp, ref, onMounted, nextTick, computed } = Vue;
import { useSettings } from './stores/settings.js';
import { useChat } from './stores/chat.js';
import { useLogs } from './stores/logs.js';
import { renderMarkdown } from './utils/helpers.js';
import { getMcpSessionIdShort } from '../shared/shared.mjs';

const serverChoices = ref(window.chat_config.serverChoices);

createApp({
  setup() {
    const settings = useSettings();
    const chat = useChat(settings);
    const logs = useLogs(settings, chat);

    onMounted(async () => {
      await settings.loadSettings();
    });

    return {
      ...settings,
      ...chat,
      ...logs,
      serverChoices,
      renderMarkdown,
      mcpSessionId: getMcpSessionIdShort(chat.sessionId),
    };
  }
}).mount('#app');
