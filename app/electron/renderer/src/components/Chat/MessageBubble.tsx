import React from "react";
import type { ChatMessage } from "../../types";
import rehypeHighlight from "rehype-highlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { saveChatImage, traceMessageChain, workerOpenFileLocation } from "../../api/gateway";

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

function formatDateTime(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${month}/${day} ${hh}:${mm}:${ss}`;
}

function truncateFileBlocks(text: string): string {
  return text.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_, lang, code) => {
    const lines = code.split("\n");
    if (lines.length <= FILE_BLOCK_DISPLAY_LINES)
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    return `\`\`\`${lang}\n${lines.slice(0, FILE_BLOCK_DISPLAY_LINES).join("\n")}\n...\n\`\`\``;
  });
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
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
  const [isTraceModalOpen, setIsTraceModalOpen] = React.useState(false);
  const [isTraceLoading, setIsTraceLoading] = React.useState(false);
  const [traceOutput, setTraceOutput] = React.useState("");
  const [previewImage, setPreviewImage] = React.useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);

  const openImagePreview = React.useCallback((src: string, width: number, height: number) => {
    setPreviewImage({ src, width, height });
  }, []);

  const closeImagePreview = React.useCallback(() => {
    setPreviewImage(null);
  }, []);

  const handleSaveImage = React.useCallback(async (src: string) => {
    const result = await saveChatImage(msgId || "image", src);
    if (!result?.ok && !result?.canceled) {
      window.alert(result?.error || "保存图片失败");
    }
  }, [msgId]);

  const handleMsgIdClick = React.useCallback(async () => {
    if (!msgId) return;
    setIsTraceModalOpen(true);
    setIsTraceLoading(true);
    setTraceOutput("");
    try {
      const result = await traceMessageChain(msgId);
      if (result?.missingPython) {
        setTraceOutput("缺少python环境");
        return;
      }
      setTraceOutput((result?.output || "").trim() || "(无输出)");
    } catch (err) {
      setTraceOutput(`查询失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsTraceLoading(false);
    }
  }, [msgId]);

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

  function renderTraceOutput(text: string) {
    const clean = stripAnsi(text || "");
    const lines = clean.split("\n");
    return lines.map((line, idx) => {
      const trimmed = line.trimStart();
      const isHighlightedLine =
        trimmed.startsWith("real usage (normalized):") ||
        trimmed.startsWith("estimated tokens (chars/4):");
      return (
        <React.Fragment key={`trace-line-${idx}`}>
          <span className={isHighlightedLine ? "font-bold text-red-600" : undefined}>{line}</span>
          {idx < lines.length - 1 ? "\n" : null}
        </React.Fragment>
      );
    });
  }

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
  const timeStr = formatDateTime(timestamp);

  const isThinking =
    typeof content === "string" &&
    (content === "思考中…" || content === "思考中...");
  const completedTimeStr = completedAt && !isThinking ? formatDateTime(completedAt) : "";

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
              <button
                type="button"
                className="cursor-pointer select-all underline decoration-dashed underline-offset-2"
                onClick={() => void handleMsgIdClick()}
              >
                {msgId}
              </button>
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
              <div key={`i-${idx}`} className="group flex items-start justify-end gap-2">
                <img
                  className="max-h-60 max-w-[min(320px,85vw)] cursor-zoom-in rounded-[10px] border border-[#d5dbe8] bg-white object-contain"
                  src={`data:${block.mediaType};base64,${block.data}`}
                  alt="用户上传图片"
                  onClick={(e) =>
                    openImagePreview(
                      `data:${block.mediaType};base64,${block.data}`,
                      e.currentTarget.naturalWidth,
                      e.currentTarget.naturalHeight
                    )
                  }
                />
                <button
                  type="button"
                  className="pointer-events-none mt-1 inline-flex h-7 w-7 items-center justify-center rounded border border-dashed border-gray-300 bg-white/95 text-gray-600 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-gray-50"
                  onClick={() => void handleSaveImage(`data:${block.mediaType};base64,${block.data}`)}
                  title="下载图片"
                  aria-label="下载图片"
                >
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                    <path d="M10 3v8m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 13.5v1a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0016 14.5v-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
          {role === "assistant" && msgId && (
            <div className="mt-1.5 text-[10px] font-mono text-gray-400">
              <button
                type="button"
                className="cursor-pointer select-all underline decoration-dashed underline-offset-2"
                onClick={() => void handleMsgIdClick()}
              >
                {msgId}
              </button>
              {completedTimeStr ? ` · 完成 ${completedTimeStr}` : ""}
            </div>
          )}
        </div>
      )}
      {previewImage && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 px-6 py-8"
          onClick={closeImagePreview}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <img
              src={previewImage.src}
              alt="预览图片"
              className="block object-contain"
              style={
                previewImage.width >= previewImage.height
                  ? {
                    width: "calc(100vw - 200px)",
                    maxHeight: "calc(100vh - 100px)",
                  }
                  : {
                    height: "calc(100vh - 100px)",
                    maxWidth: "calc(100vw - 200px)",
                  }
              }
            />
          </div>
        </div>
      )}
      {isTraceModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setIsTraceModalOpen(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5 text-sm">
              <div className="font-medium text-gray-900">消息链路追踪</div>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                onClick={() => setIsTraceModalOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="max-h-[calc(80vh-44px)] overflow-auto p-4">
              <div className="mb-2 text-xs text-gray-500">msgId: {msgId}</div>
              {isTraceLoading ? (
                <div className="text-sm text-gray-600">查询中...</div>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-800">
                  {renderTraceOutput(traceOutput)}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
