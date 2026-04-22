import { useWorkers } from './hooks/useWorkers';
import { useGroups } from './hooks/useGroups';
import { useChatStore } from './store/chatStore';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatPanel } from './components/Chat/ChatPanel';
import { GroupChatPanel } from './components/Chat/GroupChatPanel';
import styles from './App.module.css';

export function App() {
  const { reload: reloadWorkers } = useWorkers();
  const { reload: reloadGroups } = useGroups();
  const currentView = useChatStore((s) => s.currentView);

  return (
    <div className={styles.layout}>
      <Sidebar onWorkersChange={reloadWorkers} onGroupsChange={reloadGroups} />
      {currentView === 'group' ? <GroupChatPanel /> : <ChatPanel />}
    </div>
  );
}
