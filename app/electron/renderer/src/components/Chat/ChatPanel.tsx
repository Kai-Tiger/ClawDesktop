import React, { useEffect, useState } from "react";
import { getWorkerModel } from "../../api/gateway";
import { useChatStore } from "../../store/chatStore";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { WorkerSettingsDialog } from "./WorkerSettingsDialog";
import styles from "./ChatPanel.module.css";

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return collapsed ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="14" rx="1.5" fill="currentColor" opacity="0.35"/>
      <rect x="1" y="1" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M8 5.5L11 8l-3 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="14" rx="1.5" fill="currentColor" opacity="0.35"/>
      <rect x="1" y="1" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M9.5 5.5L6.5 8l3 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function ChatPanel() {
  const workers = useChatStore((s) => s.workers);
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const currentWorker = workers.find((w) => w.id === currentWorkerId);
  const [showSettings, setShowSettings] = useState(false);
  const [workerModel, setWorkerModel] = useState("");
  const sidebarVisible = useChatStore((s) => s.sidebarVisible);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);

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
          <button
            className={styles.sidebarToggleBtn}
            title={sidebarVisible ? "收起侧栏" : "展开侧栏"}
            onClick={toggleSidebar}
          >
            <SidebarToggleIcon collapsed={!sidebarVisible} />
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
        onModelApplied={(model) => setWorkerModel(model)}
      />
    </div>
  );
}
