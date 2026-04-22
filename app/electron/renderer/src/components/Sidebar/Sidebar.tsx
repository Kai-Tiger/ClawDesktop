import { useState } from "react";
import { WorkerList } from "./WorkerList";
import { GroupSection } from "./GroupSection";
import { OpenRouterForm } from "./OpenRouterForm";
import { ModelSelector } from "./ModelSelector";
import { GatewayControls } from "./GatewayControls";
import { toggleDevTools, openDashboard } from "../../api/gateway";
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
        <h3 className={styles.heading}>Workers</h3>
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
