import { useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { groupsCreate } from '../../api/gateway';
import styles from './CreateGroupDialog.module.css';

interface Props {
  onSuccess: () => void;
  onCancel: () => void;
}

export function CreateGroupDialog({ onSuccess, onCancel }: Props) {
  const workers = useChatStore((s) => s.workers);
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const toggle = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const handleCreate = async () => {
    if (!name.trim() || selectedIds.length === 0 || creating) return;
    setCreating(true);
    try {
      await groupsCreate(name.trim(), selectedIds);
      onSuccess();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={styles.dialog}>
        <h2 className={styles.title}>创建 Group</h2>

        <div className={styles.field}>
          <label className={styles.label}>Group 名称</label>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Team"
            autoFocus
            disabled={creating}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>选择 Workers</label>
          <ul className={styles.workerList}>
            {workers.map((w) => {
              const sel = selectedIds.includes(w.id);
              return (
                <li
                  key={w.id}
                  className={`${styles.workerItem} ${sel ? styles.selected : ''}`}
                  onClick={() => toggle(w.id)}
                >
                  <span className={styles.check}>{sel ? '✓' : ''}</span>
                  <span className={styles.workerName}>{w.name || w.id}</span>
                  {w.description && (
                    <span className={styles.workerDesc}>{w.description}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={creating}>
            取消
          </button>
          <button
            className={styles.createBtn}
            onClick={handleCreate}
            disabled={!name.trim() || selectedIds.length === 0 || creating}
          >
            {creating ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
