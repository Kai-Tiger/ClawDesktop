import React, { useEffect, useState } from 'react';
import { groupMemoryRead, groupMemoryWrite } from '../../api/gateway';
import styles from './GroupContextDialog.module.css';

interface Props {
  open: boolean;
  groupId: string;
  onClose: () => void;
  onSaved?: () => void;
}

const FILENAME = '_global-context.md';

export default function GroupContextDialog({ open, groupId, onClose, onSaved }: Props) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !groupId) return;
    setLoading(true);
    groupMemoryRead(groupId, FILENAME)
      .then((res) => {
        setContent(res.ok && res.content != null ? res.content : '');
      })
      .catch(() => setContent(''))
      .finally(() => setLoading(false));
  }, [open, groupId]);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    await groupMemoryWrite(groupId, FILENAME, content);
    setSaving(false);
    onSaved?.();
    onClose();
  }

  async function handleClear() {
    setSaving(true);
    await groupMemoryWrite(groupId, FILENAME, '');
    setSaving(false);
    setContent('');
    onSaved?.();
    onClose();
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>Group 全局上下文</h3>
          <span className={styles.hint}>保存后将注入到该 Group 每个 Worker 的系统提示</span>
        </div>
        {loading ? (
          <div className={styles.loading}>加载中...</div>
        ) : (
          <textarea
            className={styles.editor}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="在此输入 Markdown 格式的全局上下文，留空则不注入..."
            spellCheck={false}
          />
        )}
        <div className={styles.actions}>
          <button className={styles.clearBtn} onClick={() => void handleClear()} disabled={saving}>
            清除
          </button>
          <div className={styles.rightActions}>
            <button className={styles.cancelBtn} onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className={styles.saveBtn} onClick={() => void handleSave()} disabled={saving || loading}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
