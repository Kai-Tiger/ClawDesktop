import React from "react";
import ReactDOM from "react-dom";
import styles from "./MessageContextMenu.module.css";

interface MessageContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDelete: () => void;
  onFavorite: () => void;
}

export function MessageContextMenu({
  x,
  y,
  onClose,
  onDelete,
  onFavorite,
}: MessageContextMenuProps) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  const [pos, setPos] = React.useState({ x, y });
  React.useLayoutEffect(() => {
    if (!menuRef.current) return;
    const { offsetWidth: w, offsetHeight: h } = menuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: x + w > vw ? Math.max(0, vw - w - 8) : x,
      y: y + h > vh ? Math.max(0, vh - h - 8) : y,
    });
  }, [x, y]);

  const handleDelete = () => {
    onDelete();
    onClose();
  };

  const handleFavorite = () => {
    onFavorite();
    onClose();
  };

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        type="button"
        className={styles.item}
        onClick={handleFavorite}
      >
        <span className={styles.icon}>⭐</span>
        收藏
      </button>
      <div className={styles.divider} />
      <button
        type="button"
        className={`${styles.item} ${styles.danger}`}
        onClick={handleDelete}
      >
        <span className={styles.icon}>🗑️</span>
        删除
      </button>
    </div>,
    document.body,
  );
}
