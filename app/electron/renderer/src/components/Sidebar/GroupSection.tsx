import { useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { groupsDelete, groupsList } from '../../api/gateway';
import { CreateGroupDialog } from './CreateGroupDialog';
import styles from './GroupSection.module.css';

export function GroupSection({ onGroupsChange }: { onGroupsChange?: () => void }) {
  const groups = useChatStore((s) => s.groups);
  const currentGroupId = useChatStore((s) => s.currentGroupId);
  const currentView = useChatStore((s) => s.currentView);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const setGroups = useChatStore((s) => s.setGroups);
  const workers = useChatStore((s) => s.workers);

  const [showCreate, setShowCreate] = useState(false);

  const refresh = () => {
    groupsList().then(setGroups).catch(() => {});
    onGroupsChange?.();
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    groupsDelete(id).then(refresh).catch(() => {});
  };

  const resolveWorkerNames = (workerIds: string[]) => {
    return workerIds
      .map((id) => workers.find((w) => w.id === id)?.name || id)
      .join(', ');
  };

  return (
    <>
      {groups.length === 0 ? (
        <p className={styles.empty}>暂无 Groups</p>
      ) : (
        <ul className={styles.list}>
          {groups.map((g) => (
            <li
              key={g.id}
              className={`${styles.item} ${currentView === 'group' && g.id === currentGroupId ? styles.active : ''}`}
              onClick={() => selectGroup(g.id)}
            >
              <div className={styles.itemInfo}>
                <div className={styles.name}>{g.name}</div>
                <div className={styles.count}>{resolveWorkerNames(g.workerIds)}</div>
              </div>
              <button
                className={styles.deleteBtn}
                onClick={(e) => handleDelete(g.id, e)}
                title="删除"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className={styles.createBtn} onClick={() => setShowCreate(true)}>
        + 创建
      </button>

      {showCreate && (
        <CreateGroupDialog
          onSuccess={() => { setShowCreate(false); refresh(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </>
  );
}
