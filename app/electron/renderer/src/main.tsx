import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getChatHistory } from './api/gateway';
import { useChatStore } from './store/chatStore';
import './index.css';

function patchIds<T extends { id?: string }>(msgs: T[]): T[] {
  return msgs.map((m) =>
    m.id ? m : { ...m, id: Math.random().toString(36).slice(2) + Date.now().toString(36) }
  );
}

async function init() {
  try {
    const history = await getChatHistory();
    if (history) {
      const messages: Record<string, import('./types').ChatMessage[]> = {};
      for (const [k, v] of Object.entries(history.messages ?? {})) {
        messages[k] = patchIds(v as import('./types').ChatMessage[]);
      }
      useChatStore.setState({
        messages,
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
