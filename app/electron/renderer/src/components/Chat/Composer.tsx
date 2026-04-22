import { useRef, useState } from 'react';
import { useChat } from '../../hooks/useChat';
import { useChatStore } from '../../store/chatStore';
import type { ImageInput } from '../../types';
import styles from './Composer.module.css';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_COUNT = 3;
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type PendingImage = ImageInput & { previewUrl: string; name: string; size: number };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function convertFile(file: File): Promise<PendingImage> {
  const dataUrl = await fileToDataUrl(file);
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) throw new Error('图片数据格式错误');
  return {
    mediaType: file.type,
    data: dataUrl.slice(commaIndex + 1),
    previewUrl: dataUrl,
    name: file.name,
    size: file.size,
  };
}

export function Composer() {
  const { send, sending } = useChat();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const currentWorkerId = useChatStore((s) => s.currentWorkerId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState('');
  const [dragging, setDragging] = useState(false);

  const pickFiles = async (files: File[]) => {
    const filtered = files.filter((f) => f.type.startsWith('image/'));
    if (filtered.length === 0) return;

    if (pendingImages.length + filtered.length > MAX_IMAGE_COUNT) {
      setImageError(`最多发送 ${MAX_IMAGE_COUNT} 张图片`);
      return;
    }

    const accepted: PendingImage[] = [];
    for (const f of filtered) {
      if (!ALLOWED_MEDIA_TYPES.has(f.type)) {
        setImageError(`不支持图片类型: ${f.type || 'unknown'}`);
        return;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setImageError(`图片不能超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
        return;
      }
      accepted.push(await convertFile(f));
    }

    setPendingImages((prev) => [...prev, ...accepted]);
    setImageError('');
  };

  const handleSend = async () => {
    const text = inputRef.current?.value ?? '';
    if ((!text.trim() && pendingImages.length === 0) || sending) return;
    inputRef.current!.value = '';
    const images = pendingImages.map(({ mediaType, data }) => ({ mediaType, data }));
    setPendingImages([]);
    setImageError('');
    await send(text, images);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend();
  };

  const handleClear = () => {
    if (currentWorkerId) clearMessages(currentWorkerId);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean) as File[];
    if (files.length === 0) return;
    e.preventDefault();
    await pickFiles(files);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    await pickFiles(files);
  };

  const openFilePicker = () => fileRef.current?.click();

  const removeImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.currentTarget.value = '';
    if (files.length === 0) return;
    await pickFiles(files);
  };

  return (
    <div
      className={`${styles.composer} ${dragging ? styles.dragging : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className={styles.hiddenInput}
        onChange={onFileChange}
      />
      {pendingImages.length > 0 && (
        <div className={styles.previewRow}>
          {pendingImages.map((img, idx) => (
            <div key={`${img.name}-${idx}`} className={styles.previewCard}>
              <img src={img.previewUrl} alt={img.name || `image-${idx}`} className={styles.previewImg} />
              <button className={styles.previewDelete} onClick={() => removeImage(idx)} title="移除图片">
                x
              </button>
            </div>
          ))}
        </div>
      )}
      {imageError && <div className={styles.error}>{imageError}</div>}
      <textarea
        ref={inputRef}
        className={styles.input}
        placeholder="输入消息，粘贴/拖拽图片… (⌘Enter 发送)"
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={sending}
      />
      <div className={styles.actions}>
        <button className={styles.btnAttach} onClick={openFilePicker} title="选择图片">
          图片
        </button>
        <button className={styles.btnNew} onClick={handleClear} title="新对话（清除记录）">
          +
        </button>
        <button className={styles.btn} onClick={handleSend} disabled={sending}>
          {sending ? '…' : '发送'}
        </button>
      </div>
    </div>
  );
}
