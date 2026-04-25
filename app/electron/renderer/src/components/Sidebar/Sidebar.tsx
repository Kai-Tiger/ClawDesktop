import { useState } from "react";
import { WorkerList } from "./WorkerList";
import { GroupSection } from "./GroupSection";
import { OpenRouterForm } from "./OpenRouterForm";
import { ModelSelector } from "./ModelSelector";
import { GatewayControls } from "./GatewayControls";
import {
  toggleDevTools,
  openDashboard,
  workerOpenOpenClawDir,
} from "../../api/gateway";
import styles from "./Sidebar.module.css";

interface Props {
  onWorkersChange?: () => void;
  onGroupsChange?: () => void;
}

export function Sidebar({ onWorkersChange, onGroupsChange }: Props) {
  const [hasKey, setHasKey] = useState(true);

  return (
    <aside className={styles.sidebar}>
      <section className={styles.section}>
        <div className={styles.headingRow}>
          <h3 className={styles.heading}>Workers</h3>
          {/* <button
            className={styles.folderBtn}
            title="Open .openclaw directory"
            onClick={() => workerOpenOpenClawDir()}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.086a1.5 1.5 0 0 1 1.06.44L7.56 3.5H13.5A1.5 1.5 0 0 1 15 5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V3.5Z" fill="currentColor" opacity="0.85"/>
            </svg>
          </button> */}
        </div>
        <WorkerList onImportSuccess={onWorkersChange} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Groups</h3>
        <GroupSection onGroupsChange={onGroupsChange} />
      </section>

      <section className={styles.section}>
        <div className={styles.headingRow}>
          <h3 className={styles.heading}>OpenRouter Key</h3>
          {!hasKey && (
            <span className={styles.keyRequired}>Key is required</span>
          )}
        </div>
        <OpenRouterForm onKeyStatus={setHasKey} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Gateway</h3>
        <GatewayControls />
      </section>

      <div className={styles.debugBar}>
        <button className={styles.debugBtn} onClick={() => toggleDevTools()}>
          Debug
        </button>
        <button className={styles.debugBtn} onClick={() => openDashboard()}>
          Dashboard
        </button>
      </div>
    </aside>
  );
}
