import { useEffect } from 'react';
import { useWorkers } from './hooks/useWorkers';
import { useGroups } from './hooks/useGroups';
import { useChatStore } from './store/chatStore';
import { onCronMessage } from './api/gateway';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatPanel } from './components/Chat/ChatPanel';
import { GroupChatPanel } from './components/Chat/GroupChatPanel';
import styles from './App.module.css';

export function App() {
  const { reload: reloadWorkers } = useWorkers();
  const { reload: reloadGroups } = useGroups();
  const currentView = useChatStore((s) => s.currentView);

  useEffect(() => {
    const off = onCronMessage(({ workerId, content, role }) => {
      if (!workerId || !content) return;
      useChatStore.getState().pushMessage(workerId, { role: (role as 'assistant' | 'user') || 'assistant', content });
    });
    return off;
  }, []);

  return (
    <div className={styles.layout}>
      <Sidebar onWorkersChange={reloadWorkers} onGroupsChange={reloadGroups} />
      {currentView === 'group' ? <GroupChatPanel /> : <ChatPanel />}
    </div>
  );
}
