import { useState, useEffect } from 'react';
import { workerCopy } from '../../api/gateway';
import styles from './ImportWorkerDialog.module.css';

interface Props {
  sourceId: string;
  sourceName: string;
  sourceDescription: string;
  onSuccess: (newWorkerId: string) => void;
  onCancel: () => void;
}

export function CopyWorkerDialog({ sourceId, sourceName, sourceDescription, onSuccess, onCancel }: Props) {
  const [name, setName] = useState(`${sourceName} (副本)`);
  const [id, setId] = useState('');
  const [description, setDescription] = useState(sourceDescription);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  const [idTouched, setIdTouched] = useState(false);

  useEffect(() => {
    if (!idTouched) {
      setId(`${sourceId}-copy`);
    }
  }, [sourceId, idTouched]);

  useEffect(() => {
    if (!idTouched) {
      setId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  }, [name, idTouched]);

  async function handleCopy() {
    if (!id.trim() || !name.trim() || copying) return;
    setCopying(true);
    setError('');
    try {
      const result = await workerCopy(sourceId, id.trim(), name.trim(), description.trim());
      if (result.ok) {
        onSuccess(id.trim());
      } else {
        setError(result.error ?? '复制失败');
      }
    } catch {
      setError('复制失败');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={() => { if (!copying) onCancel(); }}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>复制 Worker</h2>

        <div className={styles.field}>
          <label className={styles.label}>名称</label>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={copying}
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>ID</label>
          <input
            className={styles.input}
            value={id}
            onChange={(e) => { setId(e.target.value); setIdTouched(true); }}
            disabled={copying}
            placeholder="my-worker-copy"
          />
          <p className={styles.hint}>小写字母、数字和连字符，唯一标识符</p>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>描述（可选）</label>
          <input
            className={styles.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={copying}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}
        {copying && <p className={styles.status}>复制中，请稍候…</p>}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={copying}>
            取消
          </button>
          <button
            className={styles.installBtn}
            onClick={() => void handleCopy()}
            disabled={copying || !id.trim() || !name.trim()}
          >
            复制
          </button>
        </div>
      </div>
    </div>
  );
}
