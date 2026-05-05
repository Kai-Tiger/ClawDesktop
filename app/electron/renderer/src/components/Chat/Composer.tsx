import { useRef, useState } from "react";
import { clearWorkerSessions } from "../../api/gateway";
import { useChat } from "../../hooks/useChat";
import { useChatStore } from "../../store/chatStore";
import type { ImageInput } from "../../types";
import styles from "./Composer.module.css";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_COUNT = 3;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_LINES = 500;
const ALLOWED_TEXT_EXTS = new Set([
  "csv",
  "txt",
  "md",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "yaml",
  "yml",
  "log",
  "xml",
  "html",
  "css",
  "sh",
]);

type PendingImage = ImageInput & {
  previewUrl: string;
  name: string;
  size: number;
};
type PendingFile = {
  name: string;
  content: string;
  lineCount: number;
  size: number;
  truncated: boolean;
};

function fileExt(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("读取失败"));
    r.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("读取失败"));
    r.readAsText(file, "utf-8");
  });
}

async function toImage(file: File): Promise<PendingImage> {
  const dataUrl = await readAsDataUrl(file);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片格式错误");
  return {
    mediaType: file.type,
    data: dataUrl.slice(comma + 1),
    previewUrl: dataUrl,
    name: file.name,
    size: file.size,
  };
}

async function toTextFile(file: File): Promise<PendingFile> {
  const raw = await readAsText(file);
  const lines = raw.split("\n");
  const truncated = lines.length > MAX_FILE_LINES;
  return {
    name: file.name,
    content: truncated ? lines.slice(0, MAX_FILE_LINES).join("\n") : raw,
    lineCount: lines.length,
    size: file.size,
    truncated,
  };
}

function buildFinalText(userText: string, files: PendingFile[]): string {
  if (files.length === 0) return userText;
  const blocks = files.map((f) => {
    const ext = fileExt(f.name);
    const note = f.truncated
      ? `\n（已截断，共 ${f.lineCount} 行，仅显示前 ${MAX_FILE_LINES} 行）`
      : "";
    return `\n\n---文件: ${f.name}---\n\`\`\`${ext}\n${f.content}\n\`\`\`${note}`;
  });
  return userText + blocks.join("");
}

export function Composer() {
  const { send, sending } = useChat();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachPickerRef = useRef<HTMLInputElement>(null);
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<{
    src: string;
    width: number;
    height: number;
    name: string;
  } | null>(null);

  const addImages = async (files: File[]) => {
    const imgs = files.filter((f) => ALLOWED_IMAGE_TYPES.has(f.type));
    if (!imgs.length) return;
    if (pendingImages.length + imgs.length > MAX_IMAGE_COUNT) {
      setAttachError(`最多发送 ${MAX_IMAGE_COUNT} 张图片`);
      return;
    }
    const results: PendingImage[] = [];
    for (const f of imgs) {
      if (f.size > MAX_IMAGE_BYTES) {
        setAttachError(`图片不能超过 2MB`);
        return;
      }
      results.push(await toImage(f));
    }
    setPendingImages((prev) => [...prev, ...results]);
    setAttachError("");
  };

  const addTextFiles = async (files: File[]) => {
    const txts = files.filter((f) => ALLOWED_TEXT_EXTS.has(fileExt(f.name)));
    if (!txts.length) return;
    const results: PendingFile[] = [];
    for (const f of txts) {
      if (f.size > MAX_FILE_BYTES) {
        setAttachError(`文件不能超过 5MB`);
        return;
      }
      results.push(await toTextFile(f));
    }
    setPendingFiles((prev) => [...prev, ...results]);
    setAttachError("");
  };

  const handleSend = async () => {
    const text = inputRef.current?.value ?? "";
    if (
      (!text.trim() && !pendingImages.length && !pendingFiles.length) ||
      sending
    )
      return;
    inputRef.current!.value = "";
    const images = pendingImages.map(({ mediaType, data }) => ({
      mediaType,
      data,
    }));
    const files = pendingFiles;
    setPendingImages([]);
    setPendingFiles([]);
    setAttachError("");
    await send(buildFinalText(text, files), images);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSend();
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean) as File[];
    if (!files.length) return;
    e.preventDefault();
    await addImages(files);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    await addImages(files);
    await addTextFiles(files);
  };

  const removeImage = (i: number) =>
    setPendingImages((prev) => prev.filter((_, idx) => idx !== i));
  const removeFile = (i: number) =>
    setPendingFiles((prev) => prev.filter((_, idx) => idx !== i));

  const handleClear = () => {
    if (!currentWorkerId) return;
    clearMessages(currentWorkerId);
    setPendingImages([]);
    setPendingFiles([]);
    setAttachError("");
    clearWorkerSessions([currentWorkerId]).catch(console.error);
  };

  const hasPreviews = pendingImages.length > 0 || pendingFiles.length > 0;

  return (
    <div
      className={`${styles.composer} ${dragging ? styles.dragging : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={attachPickerRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.csv,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.yaml,.yml,.log,.xml,.html,.css,.sh"
        multiple
        className={styles.hiddenInput}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.currentTarget.value = "";
          const imgs = files.filter((f) => ALLOWED_IMAGE_TYPES.has(f.type));
          const txts = files.filter((f) => !ALLOWED_IMAGE_TYPES.has(f.type));
          if (imgs.length) await addImages(imgs);
          if (txts.length) await addTextFiles(txts);
        }}
      />

      {hasPreviews && (
        <div className={styles.previewRow}>
          {pendingImages.map((img, i) => (
            <div key={`img-${i}`} className={styles.previewCard}>
              <img
                src={img.previewUrl}
                alt={img.name}
                className={styles.previewImg}
                onClick={(e) =>
                  setPreviewImage({
                    src: img.previewUrl,
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                    name: img.name,
                  })
                }
              />
              <button
                className={styles.previewDelete}
                onClick={() => removeImage(i)}
              >
                ×
              </button>
            </div>
          ))}
          {pendingFiles.map((f, i) => (
            <div key={`file-${i}`} className={styles.fileCard}>
              <span className={styles.fileIcon}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 1.5A1.5 1.5 0 0 1 5.5 0h5.086a1.5 1.5 0 0 1 1.06.44l2.915 2.914A1.5 1.5 0 0 1 15 4.414V14.5A1.5 1.5 0 0 1 13.5 16h-8A1.5 1.5 0 0 1 4 14.5V1.5Z"
                    fill="#6b7280"
                  />
                  <path
                    d="M9.5 0v3.5A1.5 1.5 0 0 0 11 5h4"
                    stroke="#fff"
                    strokeWidth="0.5"
                  />
                </svg>
              </span>
              <div className={styles.fileInfo}>
                <span className={styles.fileName}>{f.name}</span>
                <span className={styles.fileMeta}>
                  {f.lineCount.toLocaleString()} 行 · {formatSize(f.size)}
                  {f.truncated && (
                    <span className={styles.truncatedBadge}> 已截断</span>
                  )}
                </span>
              </div>
              <button
                className={styles.fileDelete}
                onClick={() => removeFile(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {attachError && <div className={styles.error}>{attachError}</div>}

      {previewImage && (
        <div
          className={styles.imagePreviewOverlay}
          onClick={() => setPreviewImage(null)}
        >
          <div
            className={styles.imagePreviewStage}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewImage.src}
              alt={previewImage.name}
              className={styles.imagePreviewImage}
              style={
                previewImage.width >= previewImage.height
                  ? {
                      width: "calc(100vw - 400px)",
                      maxHeight: "calc(100vh - 300px)",
                    }
                  : {
                      height: "calc(100vh - 300px)",
                      maxWidth: "calc(100vw - 400px)",
                    }
              }
            />
          </div>
        </div>
      )}

      <div className={styles.composerToolbar}>
        <button className={styles.clearBtn} onClick={handleClear}>
          /Clear
        </button>
        <button
          className={styles.fileLinkBtn}
          onClick={() => attachPickerRef.current?.click()}
          title="上传文件"
          aria-label="上传文件"
          disabled={sending}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M5.5 1.5A1.5 1.5 0 0 1 7 0h4.25a1.5 1.5 0 0 1 1.06.44l2.25 2.25A1.5 1.5 0 0 1 15 3.75V14.5A1.5 1.5 0 0 1 13.5 16H7A1.5 1.5 0 0 1 5.5 14.5V1.5Z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M9.5 0.2V3a1 1 0 0 0 1 1h2.8"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M3.2 10.9L1.9 12.2a2 2 0 1 0 2.82 2.82l2.33-2.33a2 2 0 0 0-2.82-2.82l-1.9 1.9"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className={styles.inputWrap}>
        <textarea
          ref={inputRef}
          className={styles.input}
          placeholder="输入消息，粘贴/拖拽图片或文件… (⌘Enter 发送)"
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={sending}
        />
        <div className={styles.inputSuffix}>
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={sending}
            title="发送"
            aria-label="发送"
          >
            {sending ? (
              "…"
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M14.8 1.2L7.6 14.8l-1.7-5.5L0.4 7.6 14.8 1.2Z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
