import { useGateway } from '../../hooks/useGateway';
import type { GatewayStatus } from '../../types';
import styles from './GatewayControls.module.css';

function StatusCard({ status }: { status: GatewayStatus }) {
  const running = status.rpc?.ok ?? false;
  const port = status.gateway?.port;

  return (
    <div className={styles.card}>
      <div className={styles.cardRow}>
        <span className={`${styles.dot} ${running ? styles.dotOn : styles.dotOff}`} />
        <span className={styles.cardLabel}>{running ? 'Running' : 'Stopped'}</span>
        {!running && (
          <span className={styles.cardHint}>点击 Start 启动</span>
        )}
      </div>
      {port ? (
        <div className={styles.cardRow}>
          <span className={styles.cardKey}>端口</span>
          <span className={styles.cardVal}>{port}</span>
        </div>
      ) : null}
    </div>
  );
}

export function GatewayControls() {
  const { status, lastAction, loading, refresh, start, stop } = useGateway();

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <button className={styles.btn} onClick={refresh} disabled={loading}>
          {loading ? '…' : 'Status'}
        </button>
        <button className={`${styles.btn} ${styles.btnGreen}`} onClick={start} disabled={loading}>
          Start
        </button>
        <button className={`${styles.btn} ${styles.btnRed}`} onClick={stop} disabled={loading}>
          Stop
        </button>
      </div>

      {status && <StatusCard status={status} />}

      {lastAction && (
        <div className={`${styles.actionMsg} ${lastAction.ok ? styles.actionOk : styles.actionErr}`}>
          {lastAction.text}
        </div>
      )}
    </div>
  );
}
