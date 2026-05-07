const { ref, nextTick } = Vue;
import { getMcpSessionIdShort } from "../../shared.mjs";

export function useChat(authToken, mcpServer, aiModel, sessionId) {
  const promptInput = ref('');
  const messages = ref([]);
  const error = ref('');
  const loading = ref(false);
  const inputArea = ref(null);
  const chatContainer = ref(null);

  const getRequestHeaders = () => ({
    'Content-Type': 'application/json',
    'x-adcp-auth': authToken.value,
    'x-mcp-server': mcpServer.value,
    'x-ai-model': aiModel.value,
    'x-session-id': sessionId,
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

  const handleKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      submit();
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
  };
}
