import React from "react";
import type { ChatMessage } from "../../types";
import rehypeHighlight from "rehype-highlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workerOpenFileLocation } from "../../api/gateway";

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
  const isUser = role === "user";
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
            className="inline-flex cursor-pointer items-center gap-0.5 rounded"
            onClick={() => void workerOpenFileLocation(workerId, text)}
            title={`定位文件: ${text}`}
          >
            <code className="font-mono text-[0.9em] underline decoration-dashed underline-offset-2">{children}</code>
            <span className="select-none text-[11px] leading-none">📂</span>
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
      <div className="chat-markdown min-w-0 [&_blockquote]:m-0 [&_code]:font-mono [&_code]:text-[0.9em] [&_ol]:pl-[1.2em] [&_ol]:my-0 [&_p]:my-0 [&_pre]:my-0 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-900 [&_pre]:p-2 [&_ul]:my-0 [&_ul]:pl-[1.2em] [&_p+ol]:mt-2 [&_p+pre]:mt-2 [&_p+ul]:mt-2 [&_p+p]:mt-2 [&_blockquote+p]:mt-2 [&_ol+p]:mt-2 [&_pre+p]:mt-2 [&_ul+p]:mt-2">
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

  const isThinking =
    typeof content === "string" &&
    (content === "思考中…" || content === "思考中...");
  const completedTimeStr =
    completedAt && !isThinking
      ? new Date(completedAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      : "";

  return (
    <div className={`mb-3 flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] opacity-50">
        <span>{displayName}</span>
        {timeStr && <span className="text-[10px]">{timeStr}</span>}
      </div>
      {typeof content === "string" ? (
        <div
          className={`max-w-[85%] break-words rounded-xl px-3 py-[9px] text-sm leading-6 ${isUser ? "rounded-br border border-blue-500 bg-blue-500 text-white" : "rounded-bl border border-gray-200 bg-gray-100 text-gray-900"} ${isThinking ? "animate-pulse italic" : ""}`}
        >
          {renderMarkdown(truncateFileBlocks(content))}
          {role === "assistant" && msgId && (
            <div className="mt-1.5 flex items-center gap-1 text-[10px] font-mono text-gray-400">
              <div className="select-all">{msgId}</div>
              <div>{completedTimeStr ? ` · 完成 ${completedTimeStr}` : ""}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex max-w-[85%] flex-col gap-1.5">
          {content.map((block, idx) => {
            if (block.type === "text") {
              return (
                <div
                  key={`t-${idx}`}
                  className={`break-words rounded-xl px-3 py-[9px] text-sm leading-6 ${isUser ? "rounded-br border border-blue-500 bg-blue-500 text-white" : "rounded-bl border border-gray-200 bg-gray-100 text-gray-900"}`}
                >
                  {renderMarkdown(block.text)}
                </div>
              );
            }
            return (
              <img
                key={`i-${idx}`}
                className="max-h-60 max-w-[min(320px,85vw)] rounded-[10px] border border-[#d5dbe8] bg-white object-contain"
                src={`data:${block.mediaType};base64,${block.data}`}
                alt="用户上传图片"
              />
            );
          })}
          {role === "assistant" && msgId && (
            <div className="mt-1.5 select-all text-[10px] font-mono text-gray-400">
              {msgId}
              {completedTimeStr ? ` · 完成 ${completedTimeStr}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
