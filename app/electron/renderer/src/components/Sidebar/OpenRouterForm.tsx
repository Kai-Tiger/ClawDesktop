import { useState, useEffect } from 'react';
import { getOpenRouterKey, saveOpenRouterKey } from '../../api/gateway';
import styles from './OpenRouterForm.module.css';

function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return key.slice(0, 12) + '…' + key.slice(-4);
}

interface Props {
  onKeyStatus?: (hasKey: boolean) => void;
}

export function OpenRouterForm({ onKeyStatus }: Props) {
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getOpenRouterKey().then((k) => {
      const key = k || null;
      setSavedKey(key);
      setEditing(!k);
      onKeyStatus?.(!!key);
    });
  }, []);

  const save = async () => {
    if (!input.trim()) {
      setStatus('请先输入 OpenRouter API Key');
      return;
    }
    setSaving(true);
    setStatus('保存中...');
    try {
      const res = await saveOpenRouterKey(input.trim());
      if (res.ok) {
        setSavedKey(input.trim());
        setEditing(false);
        setInput('');
        setStatus('');
        onKeyStatus?.(true);
      } else {
        setStatus(`保存失败: ${res.detail?.stderr || 'unknown'}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`保存失败: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setInput('');
    setStatus('');
  };

  // 已保存，展示缩略 + Edit 按钮
  if (savedKey && !editing) {
    return (
      <div className={styles.wrap}>
        <div className={styles.savedRow}>
          <span className={styles.keyBadge}>{maskKey(savedKey)}</span>
          <button className={styles.editBtn} onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      </div>
    );
  }

  // 输入/编辑态
  return (
    <div className={styles.wrap}>
      <div className={styles.inputRow}>
        <input
          type="password"
          className={`${styles.input} ${!savedKey ? styles.inputError : ''}`}
          placeholder="sk-or-v1-..."
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className={styles.btn} onClick={save} disabled={saving}>
          保存
        </button>
        {savedKey && (
          <button className={styles.cancelBtn} onClick={cancel} disabled={saving}>
            取消
          </button>
        )}
      </div>
      {status && <p className={styles.status}>{status}</p>}
    </div>
  );
}
