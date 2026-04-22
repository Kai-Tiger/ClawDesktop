import { useState, useEffect } from 'react';
import type { WorkerZipProbe, SkillMeta } from '../../types';
import { workerInstallFromTemp } from '../../api/gateway';
import styles from './ImportWorkerDialog.module.css';

interface Props {
  probe: WorkerZipProbe;
  onSuccess: (workerId: string) => void;
  onCancel: () => void;
}

export function ImportWorkerDialog({ probe, onSuccess, onCancel }: Props) {
  const [name, setName] = useState(probe.suggestedName);
  const [id, setId] = useState(probe.suggestedId);
  const [description, setDescription] = useState(probe.suggestedDescription);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const [installedSkills, setInstalledSkills] = useState<SkillMeta[] | null>(null);

  const [idTouched, setIdTouched] = useState(false);
  useEffect(() => {
    if (!idTouched) {
      setId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  }, [name, idTouched]);

  async function handleInstall() {
    if (!id.trim() || !name.trim() || installing) return;
    setInstalling(true);
    setError('');
    try {
      const result = await workerInstallFromTemp(
        probe.tempDir, probe.rootDir,
        id.trim(), name.trim(), description.trim()
      );
      if (result.ok) {
        setInstalledSkills(result.skills ?? []);
      } else {
        setError(result.error ?? '安装失败');
      }
    } catch {
      setError('安装失败');
    } finally {
      setInstalling(false);
    }
  }

  if (installedSkills !== null) {
    return (
      <div className={styles.overlay}>
        <div className={styles.dialog}>
          <h2 className={styles.title}>安装成功</h2>
          {installedSkills.length > 0 ? (
            <>
              <p className={styles.skillsLabel}>已注册 {installedSkills.length} 个 skill：</p>
              <ul className={styles.skillList}>
                {installedSkills.map((s) => (
                  <li key={s.name} className={styles.skillItem}>
                    <span className={styles.skillName}>{s.name}</span>
                    <span className={styles.skillDesc}>{s.description}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className={styles.status}>未发现 skills</p>
          )}
          <div className={styles.actions}>
            <button className={styles.installBtn} onClick={() => onSuccess(id.trim())}>完成</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <h2 className={styles.title}>导入 Worker</h2>

        <div className={styles.field}>
          <label className={styles.label}>名称</label>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={installing}
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>ID</label>
          <input
            className={styles.input}
            value={id}
            onChange={(e) => { setId(e.target.value); setIdTouched(true); }}
            disabled={installing}
            placeholder="my-worker"
          />
          <p className={styles.hint}>小写字母、数字和连字符，唯一标识符</p>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>描述（可选）</label>
          <input
            className={styles.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={installing}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}
        {installing && <p className={styles.status}>正在安装…</p>}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={installing}>
            取消
          </button>
          <button className={styles.installBtn} onClick={handleInstall} disabled={installing || !id.trim() || !name.trim()}>
            安装
          </button>
        </div>
      </div>
    </div>
  );
}
