import React from "react";
import type { ChatMessage } from "../../types";
import rehypeHighlight from "rehype-highlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workerOpenFileLocation } from "../../api/gateway";
import styles from "./MessageBubble.module.css";

const FILE_BLOCK_DISPLAY_LINES = 10;

const FILE_EXT_RE =
  /\.(ts|tsx|js|jsx|json|md|txt|py|css|html|htm|yaml|yml|sh|bash|env|toml|xml|csv|sql|go|rs|java|kt|swift|rb|php|c|cpp|h|vue|svelte|lock|log|conf|cfg)$/i;

function looksLikeFilePath(text: string): boolean {
  if (text.length > 300 || text.includes("\n")) return false;
  if (text.startsWith("/") || text.startsWith("./") || text.startsWith("../"))
    return true;
  if (FILE_EXT_RE.test(text.trim())) return true;
  return false;
}

function normalizeNewlines(text: string) {
  return text.replace(/\n{2,}/g, "\n");
}

function truncateFileBlocks(text: string): string {
  return text.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_, lang, code) => {
    const lines = code.split("\n");
    if (lines.length <= FILE_BLOCK_DISPLAY_LINES)
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    return `\`\`\`${lang}\n${lines.slice(0, FILE_BLOCK_DISPLAY_LINES).join("\n")}\n...\n\`\`\``;
  });
}

interface MessageBubbleProps extends ChatMessage {
  workerName?: string;
  workerId?: string;
}

export function MessageBubble({
  role,
  content,
  timestamp,
  completedAt,
  workerName,
  workerId,
  msgId,
}: MessageBubbleProps) {
  const codeComponents = {
    code({
      children,
      className,
      ...props
    }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
      const text = String(children).trim();
      const isBlock = !!className;
      if (!isBlock && workerId && looksLikeFilePath(text)) {
        return (
          <span
            className={styles.fileLink}
            onClick={() => void workerOpenFileLocation(workerId, text)}
            title={`打开目录: ${text}`}
          >
            <code className={styles.fileLinkCode}>{children}</code>
            <span className={styles.fileLinkIcon}>📂</span>
          </span>
        );
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  function renderMarkdown(text: string) {
    return (
      <div className={styles.markdown}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={codeComponents}
        >
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
        second: "2-digit",
        hour12: false,
      })
    : "";

  const isThinking = typeof content === 'string' && (content === '思考中…' || content === '思考中...');
  const completedTimeStr = completedAt && !isThinking
    ? new Date(completedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "";

  return (
    <div className={`${styles.msg} ${styles[role]}`}>
      <div className={styles.label}>
        <span>{displayName}</span>
        {timeStr && <span className={styles.time}>{timeStr}</span>}
      </div>
      {typeof content === "string" ? (
        <div
          className={`${styles.bubble} ${content === "思考中…" || content === "思考中..." ? styles.thinking : ""}`}
        >
          {renderMarkdown(truncateFileBlocks(content))}
          {role === "assistant" && msgId && (
            <div className={styles.msgIdTag}>
              {msgId}
              {completedTimeStr ? ` · 完成 ${completedTimeStr}` : ""}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.multiBlocks}>
          {content.map((block, idx) => {
            if (block.type === "text") {
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
          {role === "assistant" && msgId && (
            <div className={styles.msgIdTag}>
              {msgId}
              {completedTimeStr ? ` · 完成 ${completedTimeStr}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
