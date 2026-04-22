import { useEffect, useState } from "react";
import { getWorkerModel } from "../../api/gateway";
import { useChatStore } from "../../store/chatStore";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { WorkerSettingsDialog } from "./WorkerSettingsDialog";
import styles from "./ChatPanel.module.css";

export function ChatPanel() {
  const workers = useChatStore((s) => s.workers);
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const currentWorker = workers.find((w) => w.id === currentWorkerId);
  const [showSettings, setShowSettings] = useState(false);
  const [workerModel, setWorkerModel] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!currentWorkerId) {
      setWorkerModel("未选择 Worker");
      return () => {
        cancelled = true;
      };
    }

    setWorkerModel("加载中...");
    getWorkerModel(currentWorkerId)
      .then((model) => {
        if (cancelled) return;
        setWorkerModel(model || "未设置");
      })
      .catch(() => {
        if (cancelled) return;
        setWorkerModel("读取失败");
      });

    return () => {
      cancelled = true;
    };
  }, [currentWorkerId, showSettings]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>Chat</span>
          <span className={styles.badge}>{currentWorker?.name ?? "—"}</span>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.modelInfo} title={workerModel}>
            <span className={styles.modelValue}>{workerModel || "—"}</span>
          </div>
          <button
            className={styles.settingsBtn}
            title="Channel 设置"
            onClick={() => setShowSettings(true)}
            disabled={!currentWorkerId}
          >
            ⚙
          </button>
        </div>
      </div>
      <MessageList />
      <Composer />
      <WorkerSettingsDialog
        open={showSettings}
        workerId={currentWorkerId}
        workerName={currentWorker?.name ?? currentWorkerId}
        onClose={() => setShowSettings(false)}
      />
    </div>
  );
}
