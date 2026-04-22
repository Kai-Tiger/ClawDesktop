import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getChatHistory } from './api/gateway';
import { useChatStore } from './store/chatStore';
import './index.css';

async function init() {
  try {
    const history = await getChatHistory();
    if (history) {
      useChatStore.setState({
        messages: (history.messages ?? {}) as Record<string, import('./types').ChatMessage[]>,
        groupMessages: (history.groupMessages ?? {}) as Record<string, import('./types').GroupMessage[]>,
      });
    }
  } catch {
    // first launch or file missing, start fresh
  }
  createRoot(document.getElementById('app')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

init();
