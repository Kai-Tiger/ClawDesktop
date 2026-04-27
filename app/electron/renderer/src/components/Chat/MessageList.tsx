import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { MessageBubble } from './MessageBubble';
import styles from './MessageList.module.css';

export function MessageList() {
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const messagesMap = useChatStore((s) => s.messages);
  const workers = useChatStore((s) => s.workers);
  const [progressCollapsed, setProgressCollapsed] = useState(true);
  const messages = messagesMap[currentWorkerId] ?? [];
  const progressMessages = messages.filter(
    (msg) =>
      msg.role === 'assistant' &&
      typeof msg.content === 'string' &&
      msg.content.startsWith('🟡 进度:')
  );
  const normalMessages = messages.filter(
    (msg) =>
      !(msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.startsWith('🟡 进度:'))
  );
  const workerName = workers.find((w) => w.id === currentWorkerId)?.name;
  const bottomRef = useRef<HTMLDivElement>(null);

  const anchorIndex = (() => {
    for (let i = normalMessages.length - 1; i >= 0; i -= 1) {
      if (normalMessages[i].role === 'assistant') return i;
    }
    return Math.max(0, normalMessages.length - 1);
  })();

  const progressDisplay = progressCollapsed
    ? progressMessages.slice(-1)
    : progressMessages.slice(-12);

  useEffect(() => {
    setProgressCollapsed(true);
  }, [currentWorkerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [currentWorkerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className={styles.list}>
      {normalMessages.map((msg, i) => (
        <div key={`m-${i}`}>
          {progressMessages.length > 0 && i === anchorIndex && (
            <div className={styles.progressPanel}>
              <div className={styles.progressHeader}>
                <div className={styles.progressTitle}>执行回传（{progressMessages.length}）</div>
                <button
                  type="button"
                  className={styles.progressToggle}
                  onClick={() => setProgressCollapsed((v) => !v)}
                >
                  {progressCollapsed ? '展开' : '收起'}
                </button>
              </div>
              {progressDisplay.map((pmsg, pIndex) => (
                <div key={`p-${pIndex}`} className={styles.progressItem}>
                  {typeof pmsg.content === 'string' ? pmsg.content : ''}
                </div>
              ))}
            </div>
          )}
          <MessageBubble {...msg} workerName={workerName} workerId={currentWorkerId} />
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
