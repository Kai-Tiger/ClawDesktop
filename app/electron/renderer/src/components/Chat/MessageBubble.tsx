import type { ChatMessage } from "../../types";
import rehypeHighlight from "rehype-highlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./MessageBubble.module.css";

const FILE_BLOCK_DISPLAY_LINES = 10;

function normalizeNewlines(text: string) {
  return text.replace(/\n{2,}/g, '\n');
}

function truncateFileBlocks(text: string): string {
  return text.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_, lang, code) => {
    const lines = code.split('\n');
    if (lines.length <= FILE_BLOCK_DISPLAY_LINES) return `\`\`\`${lang}\n${code}\n\`\`\``;
    return `\`\`\`${lang}\n${lines.slice(0, FILE_BLOCK_DISPLAY_LINES).join('\n')}\n...\n\`\`\``;
  });
}

interface MessageBubbleProps extends ChatMessage {
  workerName?: string;
}

export function MessageBubble({
  role,
  content,
  timestamp,
  statusLines,
  workerName,
}: MessageBubbleProps) {
  function renderMarkdown(text: string) {
    return (
      <div className={styles.markdown}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {normalizeNewlines(text)}
        </ReactMarkdown>
      </div>
    );
  }

  const displayName = role === "user" ? "你" : (workerName ?? "Assistant");
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

  return (
    <div className={`${styles.msg} ${styles[role]}`}>
      <div className={styles.label}>
        <span>{displayName}</span>
        {timeStr && <span className={styles.time}>{timeStr}</span>}
      </div>
      {/* 注释 statusLine */}
      {/* <div className={styles.statusLines}>
        {(statusLines ?? []).map((line, i) => (
          <div key={i} className={styles.statusLine}>{line}</div>
        ))}
      </div> */}
      {typeof content === 'string' ? (
        <div className={`${styles.bubble} ${(content === '思考中…' || content === '思考中...') ? styles.thinking : ''}`}>
          {renderMarkdown(truncateFileBlocks(content))}
        </div>
      ) : (
        <div className={styles.multiBlocks}>
          {content.map((block, idx) => {
            if (block.type === 'text') {
              return (
                <div key={`t-${idx}`} className={styles.bubble}>
                  {renderMarkdown(block.text)}
                </div>
              );
            }
            return (
              <img
                key={`i-${idx}`}
                className={styles.inlineImage}
                src={`data:${block.mediaType};base64,${block.data}`}
                alt="用户上传图片"
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
