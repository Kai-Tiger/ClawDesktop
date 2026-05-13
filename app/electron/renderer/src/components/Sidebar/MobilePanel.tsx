import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { mobileConnectionInfo } from '../../api/gateway';
import styles from './MobilePanel.module.css';

type ConnectionInfo = { ip: string; port: number; token: string; running: boolean };

export function MobilePanel() {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await mobileConnectionInfo();
      setInfo(data);
      const payload = JSON.stringify({ ip: data.ip, port: data.port, token: data.token });
      const url = await QRCode.toDataURL(payload, { width: 160, margin: 1 });
      setQrDataUrl(url);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const copyToken = () => {
    if (!info) return;
    navigator.clipboard.writeText(info.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (loading) return <div className={styles.hint}>加载中…</div>;
  if (!info) return <div className={styles.hint}>获取连接信息失败</div>;

  return (
    <div className={styles.wrap}>
      <div className={styles.statusRow}>
        <span className={`${styles.dot} ${info.running ? styles.dotOn : styles.dotOff}`} />
        <span className={styles.statusText}>{info.running ? '服务运行中' : '服务未启动'}</span>
        <button className={styles.refreshBtn} onClick={load} title="刷新">↺</button>
      </div>

      {info.running && (
        <>
          <div className={styles.qrWrap}>
            {qrDataUrl
              ? <img src={qrDataUrl} width={160} height={160} alt="QR Code" className={styles.qr} />
              : <div className={styles.qrPlaceholder}>生成中…</div>
            }
          </div>
          <p className={styles.qrHint}>手机打开 App → 设置 → 扫描二维码</p>

          <div className={styles.infoRow}>
            <span className={styles.infoKey}>地址</span>
            <span className={styles.infoVal}>{info.ip}:{info.port}</span>
          </div>

          <div className={styles.infoRow}>
            <span className={styles.infoKey}>Token</span>
            <span className={styles.infoVal}>{info.token.slice(0, 8)}…</span>
            <button className={styles.copyBtn} onClick={copyToken}>
              {copied ? '✓' : '复制'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
