import { useEffect, useRef } from 'react';
import { useChatStore } from '../../store/chatStore';
import { MessageBubble } from './MessageBubble';
import styles from './MessageList.module.css';

export function MessageList() {
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const messagesMap = useChatStore((s) => s.messages);
  const workers = useChatStore((s) => s.workers);
  const messages = messagesMap[currentWorkerId] ?? [];
  const workerName = workers.find((w) => w.id === currentWorkerId)?.name;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [currentWorkerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className={styles.list}>
      {messages.map((msg, i) => (
        <MessageBubble key={i} {...msg} workerName={workerName} workerId={currentWorkerId} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
