import { useState, useEffect, useRef } from "react";
import { useChatStore } from "../../store/chatStore";
import {
  workerOpenFileDialog,
  workerOpenSkillDirDialog,
  workerProbeZip,
  workerListSkills,
  chatSend,
  workerGetInternZipPath,
  workerGetBlankZipPath,
  workerExport,
  workerReadSkill,
  workerSaveSkill,
  workerInstallSkillFromDir,
  workerOpenWorkerDir,
  workerUpdateMeta,
  clearWorkerSessions,
} from "../../api/gateway";
import type { WorkerZipProbe, SkillMeta } from "../../types";
import { ImportWorkerDialog } from "./ImportWorkerDialog";
import { DeleteWorkerDialog } from "./DeleteWorkerDialog";
import styles from "./WorkerList.module.css";

export function WorkerList({
  onImportSuccess,
}: {
  onImportSuccess?: () => void;
}) {
  const workers = useChatStore((s) => s.workers);
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const selectWorker = useChatStore((s) => s.selectWorker);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const { pushMessage, updateLastMessage } = useChatStore();

  const [probing, setProbing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [probe, setProbe] = useState<WorkerZipProbe | null>(null);
  const [probeError, setProbeError] = useState("");
  const [skillsMap, setSkillsMap] = useState<Record<string, SkillMeta[]>>({});
  const [showDelete, setShowDelete] = useState(false);
  const [editingSkill, setEditingSkill] = useState<{
    workerId: string;
    skillId: string;
    skillName: string;
  } | null>(null);
  const [skillContent, setSkillContent] = useState("");
  const [loadingSkill, setLoadingSkill] = useState(false);
  const [savingSkill, setSavingSkill] = useState(false);
  const [skillError, setSkillError] = useState("");
  const [installingSkillWorkerId, setInstallingSkillWorkerId] = useState<
    string | null
  >(null);
  const [activeSkillTooltip, setActiveSkillTooltip] = useState<string | null>(
    null,
  );
  const skillTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeWorkerMenu, setActiveWorkerMenu] = useState<string | null>(null);
  const workerMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editingWorker, setEditingWorker] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);
  const [editWorkerName, setEditWorkerName] = useState("");
  const [editWorkerDesc, setEditWorkerDesc] = useState("");
  const [savingWorkerMeta, setSavingWorkerMeta] = useState(false);
  const [workerMetaError, setWorkerMetaError] = useState("");
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    workers
      .filter((w) => w.mode === "agent")
      .forEach((w) => {
        workerListSkills(w.id)
          .then((skills) =>
            setSkillsMap((prev) => ({ ...prev, [w.id]: skills })),
          )
          .catch(() => {});
      });
  }, [workers]);

  useEffect(() => {
    if (!showCreateMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!createMenuRef.current?.contains(target)) {
        setShowCreateMenu(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [showCreateMenu]);

  async function handleImportClick() {
    if (probing) return;
    setProbeError("");
    setProbing(true);
    try {
      const zipPath = await workerOpenFileDialog();
      if (!zipPath) return;
      const result = await workerProbeZip(zipPath);
      setProbe(result);
    } catch {
      setProbeError("读取文件失败");
    } finally {
      setProbing(false);
    }
  }

  async function handleCreateBlankClick() {
    if (probing) return;
    setShowCreateMenu(false);
    setProbeError("");
    setProbing(true);
    try {
      const zipPath = await workerGetBlankZipPath();
      const result = await workerProbeZip(zipPath);
      setProbe(result);
    } catch {
      setProbeError("读取 blank.zip 失败");
    } finally {
      setProbing(false);
    }
  }

  async function handleCreateInternClick() {
    if (probing) return;
    setShowCreateMenu(false);
    setProbeError("");
    setProbing(true);
    try {
      const zipPath = await workerGetInternZipPath();
      const result = await workerProbeZip(zipPath);
      setProbe(result);
    } catch {
      setProbeError("读取 intern.zip 失败");
    } finally {
      setProbing(false);
    }
  }

  async function handleExportClick() {
    if (!currentWorkerId || exporting || probing) return;
    setProbeError("");
    setExporting(true);
    try {
      const result = await workerExport(currentWorkerId);
      if (!result.ok && !result.canceled) {
        setProbeError(result.error || "导出失败");
      }
    } catch {
      setProbeError("导出失败");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportSuccess(workerId: string) {
    setProbe(null);
    onImportSuccess?.();
    selectWorker(workerId);
    pushMessage(workerId, { role: "assistant", content: "思考中…" });
    try {
      const res = await chatSend(
        workerId,
        "请按照你的设定，向用户发送一条欢迎消息，介绍你自己的能力和使用方式。不要提及这条触发指令本身。三百字以内。",
        undefined,
        [],
      );
      updateLastMessage(workerId, res.reply || "你好，我已准备好为你服务。");
    } catch {
      updateLastMessage(workerId, "你好，我已准备好为你服务。");
    }
  }

  function openWorkerMetaEditor(w: {
    id: string;
    name: string;
    description?: string;
  }) {
    setWorkerMetaError("");
    setEditWorkerName(w.name);
    setEditWorkerDesc(w.description ?? "");
    setEditingWorker({
      id: w.id,
      name: w.name,
      description: w.description ?? "",
    });
    setActiveWorkerMenu(null);
  }

  async function handleWorkerMetaSave() {
    if (!editingWorker || savingWorkerMeta) return;
    const trimmedName = editWorkerName.trim();
    if (!trimmedName) {
      setWorkerMetaError("名称不能为空");
      return;
    }
    setWorkerMetaError("");
    setSavingWorkerMeta(true);
    try {
      const result = await workerUpdateMeta(
        editingWorker.id,
        trimmedName,
        editWorkerDesc.trim(),
      );
      if (!result.ok) {
        setWorkerMetaError(result.error || "保存失败");
        return;
      }
      onImportSuccess?.();
      setEditingWorker(null);
    } catch {
      setWorkerMetaError("保存失败");
    } finally {
      setSavingWorkerMeta(false);
    }
  }

  async function handleSkillEditOpen(workerId: string, skill: SkillMeta) {
    const skillId = skill.id?.trim();
    if (!skillId) {
      setProbeError(`skill ${skill.name} 缺少标识，无法编辑`);
      return;
    }
    setSkillError("");
    setLoadingSkill(true);
    setEditingSkill({ workerId, skillId, skillName: skill.name });
    try {
      const result = await workerReadSkill(workerId, skillId);
      if (!result.ok) {
        setSkillError(result.error || "读取 SKILL.md 失败");
        setSkillContent("");
        return;
      }
      setSkillContent(result.content || "");
    } catch {
      setSkillError("读取 SKILL.md 失败");
      setSkillContent("");
    } finally {
      setLoadingSkill(false);
    }
  }

  function closeSkillEditor(force = false) {
    if (savingSkill && !force) return;
    setEditingSkill(null);
    setSkillContent("");
    setSkillError("");
  }

  async function handleSkillSave() {
    if (!editingSkill || savingSkill) return;
    setSkillError("");
    setSavingSkill(true);
    try {
      const result = await workerSaveSkill(
        editingSkill.workerId,
        editingSkill.skillId,
        skillContent,
      );
      if (!result.ok) {
        setSkillError(result.error || "保存失败");
        return;
      }
      const skills = await workerListSkills(editingSkill.workerId);
      setSkillsMap((prev) => ({ ...prev, [editingSkill.workerId]: skills }));
      closeSkillEditor(true);
    } catch {
      setSkillError("保存失败");
    } finally {
      setSavingSkill(false);
    }
  }

  async function handleSkillImportClick(workerId: string) {
    if (installingSkillWorkerId) return;
    setProbeError("");
    setInstallingSkillWorkerId(workerId);
    try {
      const skillDirPath = await workerOpenSkillDirDialog();
      if (!skillDirPath) return;
      const result = await workerInstallSkillFromDir(workerId, skillDirPath);
      if (!result.ok) {
        setProbeError(result.error || "加载 skill 失败");
        return;
      }
      setSkillsMap((prev) => ({ ...prev, [workerId]: result.skills ?? [] }));
      await clearWorkerSessions([workerId]);
    } catch {
      setProbeError("加载 skill 失败");
    } finally {
      setInstallingSkillWorkerId(null);
    }
  }

  return (
    <>
      {workers.length === 0 ? (
        <p className={styles.empty}>未发现 workers</p>
      ) : (
        <ul className={styles.list}>
          {workers.map((w) => {
            const skills = skillsMap[w.id] ?? [];
            return (
              <li
                key={w.id}
                className={`${styles.item} ${w.id === currentWorkerId ? styles.active : ""}`}
                onClick={() => selectWorker(w.id)}
              >
                <div className={styles.itemMain}>
                  <div className={styles.itemText}>
                    <div className={styles.name}>{w.name || w.id}</div>
                    {w.description && (
                      <div className={styles.desc}>{w.description}</div>
                    )}
                  </div>
                  {w.mode === "agent" && skills.length > 0 && (
                    <div
                      className={styles.skillBtnWrap}
                      onClick={(e) => e.stopPropagation()}
                      onMouseEnter={() => {
                        if (skillTooltipTimer.current) {
                          clearTimeout(skillTooltipTimer.current);
                          skillTooltipTimer.current = null;
                        }
                        setActiveSkillTooltip(w.id);
                      }}
                      onMouseLeave={() => {
                        skillTooltipTimer.current = setTimeout(() => {
                          setActiveSkillTooltip(null);
                        }, 300);
                      }}
                    >
                      <button className={styles.skillBtn}>
                        ⚡{skills.length}
                      </button>
                      <div
                        className={`${styles.skillTooltip} ${activeSkillTooltip === w.id ? styles.skillTooltipVisible : ""}`}
                      >
                        <div className={styles.tooltipTitle}>Skills</div>
                        {skills.map((s) => (
                          <div
                            key={s.id || s.name}
                            className={styles.tooltipItem}
                          >
                            <div className={styles.tooltipHead}>
                              <span className={styles.tooltipName}>
                                {s.name}
                              </span>
                              <button
                                className={styles.tooltipEditBtn}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleSkillEditOpen(w.id, s);
                                }}
                              >
                                Edit
                              </button>
                            </div>
                            {s.description && (
                              <span className={styles.tooltipDesc}>
                                {s.description}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div
                    className={styles.workerMenuWrap}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      if (workerMenuTimer.current) {
                        clearTimeout(workerMenuTimer.current);
                        workerMenuTimer.current = null;
                      }
                      setActiveWorkerMenu(w.id);
                    }}
                    onMouseLeave={() => {
                      workerMenuTimer.current = setTimeout(() => {
                        setActiveWorkerMenu(null);
                      }, 200);
                    }}
                  >
                    <button className={styles.workerMenuBtn}>···</button>
                    <div
                      className={`${styles.workerMenuDropdown} ${activeWorkerMenu === w.id ? styles.workerMenuDropdownVisible : ""}`}
                    >
                      <button
                        className={styles.workerMenuItem}
                        disabled={installingSkillWorkerId === w.id}
                        onClick={() => void handleSkillImportClick(w.id)}
                      >
                        {installingSkillWorkerId === w.id
                          ? "导入中…"
                          : "导入 Skill"}
                      </button>
                      <button
                        className={styles.workerMenuItem}
                        onClick={() => void workerOpenWorkerDir(w.id)}
                      >
                        打开目录
                      </button>
                      <button
                        className={styles.workerMenuItem}
                        onClick={() => openWorkerMetaEditor(w)}
                      >
                        编辑信息
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.btnRow}>
        <div className={styles.createBtnWrap} ref={createMenuRef}>
          <button
            className={styles.importBtn}
            onClick={() => setShowCreateMenu((v) => !v)}
            disabled={probing}
          >
            {probing ? "读取中…" : "+ 新建"}
          </button>
          <div
            className={`${styles.createMenu} ${showCreateMenu ? styles.createMenuVisible : ""}`}
          >
            <button
              className={styles.createMenuItem}
              onClick={() => void handleCreateBlankClick()}
              disabled={probing}
            >
              空白 Worker
            </button>
            <button
              className={styles.createMenuItem}
              onClick={() => void handleCreateInternClick()}
              disabled={probing}
            >
              Intern Worker
            </button>
          </div>
        </div>
        <button
          className={styles.importBtn}
          onClick={handleImportClick}
          disabled={probing}
        >
          {probing ? "读取中…" : "↑ 导入"}
        </button>
        <button
          className={styles.importBtn}
          onClick={handleExportClick}
          disabled={!currentWorkerId || probing || exporting}
        >
          {exporting ? "导出中…" : "↓ 导出"}
        </button>
        <button
          className={styles.deleteBtn}
          onClick={() => setShowDelete(true)}
        >
          删除
        </button>
      </div>
      {probeError && <p className={styles.importError}>{probeError}</p>}

      {probe && (
        <ImportWorkerDialog
          probe={probe}
          onSuccess={handleImportSuccess}
          onCancel={() => setProbe(null)}
        />
      )}

      {showDelete && (
        <DeleteWorkerDialog
          workers={workers}
          onSuccess={(deletedIds) => {
            deletedIds.forEach((id) => clearMessages(id));
            setShowDelete(false);
            onImportSuccess?.();
          }}
          onCancel={() => setShowDelete(false)}
        />
      )}

      {editingWorker && (
        <div
          className={styles.editorOverlay}
          onClick={() => {
            if (!savingWorkerMeta) setEditingWorker(null);
          }}
        >
          <div
            className={styles.metaDialog}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.editorHeader}>
              <div className={styles.editorTitle}>编辑 Worker 信息</div>
              <div className={styles.editorActions}>
                <button
                  className={styles.editorBtn}
                  onClick={() => setEditingWorker(null)}
                  disabled={savingWorkerMeta}
                >
                  取消
                </button>
                <button
                  className={styles.editorPrimaryBtn}
                  onClick={() => void handleWorkerMetaSave()}
                  disabled={savingWorkerMeta}
                >
                  {savingWorkerMeta ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
            <div className={styles.metaDialogBody}>
              <label className={styles.metaLabel}>
                <span className={styles.metaLabelText}>ID（不可修改）</span>
                <input
                  className={`${styles.metaInput} ${styles.metaInputDisabled}`}
                  value={editingWorker.id}
                  disabled
                />
              </label>
              <label className={styles.metaLabel}>
                <span className={styles.metaLabelText}>名称</span>
                <input
                  className={styles.metaInput}
                  value={editWorkerName}
                  onChange={(e) => setEditWorkerName(e.target.value)}
                  placeholder="Worker 名称"
                  autoFocus
                />
              </label>
              <label className={styles.metaLabel}>
                <span className={styles.metaLabelText}>描述</span>
                <input
                  className={styles.metaInput}
                  value={editWorkerDesc}
                  onChange={(e) => setEditWorkerDesc(e.target.value)}
                  placeholder="可选描述"
                />
              </label>
              {workerMetaError && (
                <div className={styles.editorError}>{workerMetaError}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {editingSkill && (
        <div
          className={styles.editorOverlay}
          onClick={() => closeSkillEditor()}
        >
          <div
            className={styles.editorDialog}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.editorHeader}>
              <div className={styles.editorTitle}>
                编辑 Skill: {editingSkill.skillName}
              </div>
              <div className={styles.editorActions}>
                <button
                  className={styles.editorBtn}
                  onClick={() => closeSkillEditor()}
                  disabled={savingSkill}
                >
                  取消
                </button>
                <button
                  className={styles.editorPrimaryBtn}
                  onClick={() => void handleSkillSave()}
                  disabled={loadingSkill || savingSkill}
                >
                  {savingSkill ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
            <div className={styles.editorBody}>
              {loadingSkill ? (
                <div className={styles.editorLoading}>读取中…</div>
              ) : (
                <textarea
                  className={styles.editorTextarea}
                  value={skillContent}
                  onChange={(e) => setSkillContent(e.target.value)}
                  spellCheck={false}
                />
              )}
              {skillError && (
                <div className={styles.editorError}>{skillError}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
