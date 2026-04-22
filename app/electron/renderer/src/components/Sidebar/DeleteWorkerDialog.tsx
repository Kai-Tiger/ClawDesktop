import { useState } from 'react';
import type { WorkerMeta } from '../../types';
import { workerDelete } from '../../api/gateway';
import styles from './DeleteWorkerDialog.module.css';

interface Props {
  workers: WorkerMeta[];
  onSuccess: (deletedIds: string[]) => void;
  onCancel: () => void;
}

export function DeleteWorkerDialog({ workers, onSuccess, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    setError('');
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const id of selected) {
      const res = await workerDelete(id);
      if (res.ok) deleted.push(id);
      else errors.push(`${id}: ${res.error}`);
    }
    setDeleting(false);
    if (errors.length > 0) setError(errors.join('\n'));
    if (deleted.length > 0) onSuccess(deleted);
  };

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>删除 Worker</h3>
        {workers.length === 0 ? (
          <p className={styles.empty}>没有可删除的 Worker</p>
        ) : (
          <ul className={styles.list}>
            {workers.map((w) => (
              <li
                key={w.id}
                className={`${styles.item} ${selected.has(w.id) ? styles.itemSelected : ''}`}
                onClick={() => toggle(w.id)}
              >
                <input
                  type="checkbox"
                  checked={selected.has(w.id)}
                  onChange={() => toggle(w.id)}
                  onClick={(e) => e.stopPropagation()}
                  className={styles.checkbox}
                />
                <div className={styles.info}>
                  <span className={styles.name}>{w.name || w.id}</span>
                  {w.description && <span className={styles.desc}>{w.description}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={deleting}>
            取消
          </button>
          <button
            className={styles.deleteBtn}
            onClick={confirm}
            disabled={deleting || selected.size === 0}
          >
            {deleting ? '删除中…' : `删除${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
