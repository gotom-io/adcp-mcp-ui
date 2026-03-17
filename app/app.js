const { createApp, ref, onMounted, nextTick } = Vue;

createApp({
  setup() {
    const authToken = ref('');
    const mcpServer = ref('https://dev-demo-mcp.gotom.io');
    const aiModel = ref('anthropic:claude-sonnet-4-6');
    const promptInput = ref('');
    const messages = ref([]);
    const error = ref('');
    const loading = ref(false);
    const chatContainer = ref(null);
    const inputArea = ref(null);
    
    // Generate unique session ID for this browser tab
    const sessionId = crypto.randomUUID();

    const getCookie = (name) => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop().split(';').shift();
      return '';
    };

    const saveCookie = () => {
      document.cookie = `adcp_auth=${authToken.value}; path=/; max-age=31536000`;
    };

    const saveServerCookie = () => {
      document.cookie = `mcp_server=${mcpServer.value}; path=/; max-age=31536000`;
    };

    const saveModelCookie = () => {
      document.cookie = `ai_model=${aiModel.value}; path=/; max-age=31536000`;
    };

    onMounted(() => {
      authToken.value = getCookie('adcp_auth');
      const savedServer = getCookie('mcp_server');
      if (savedServer) {
        mcpServer.value = savedServer;
      }
      const savedModel = getCookie('ai_model');
      if (savedModel) {
        aiModel.value = savedModel;
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

    const renderMarkdown = (text) => {
      if (!text) return '';
      return marked.parse(text);
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
      'x-adcp-auth': authToken.value,
      'x-mcp-server': mcpServer.value,
      'x-ai-model': aiModel.value,
      'x-session-id': sessionId,
    });

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
      renderMarkdown
    };
  }
}).mount('#app');
