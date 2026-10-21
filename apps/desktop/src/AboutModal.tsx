interface AboutModalProps {
  version: string;
  onClose: () => void;
}

export function AboutModal({ version, onClose }: AboutModalProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl"
        role="dialog"
        aria-labelledby="about-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="about-title" className="text-sm">
          关于橦云数据库
        </h2>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
          版本 {version}。窗口里是原来的数据工作台，查询、变更计划和 MCP 仍由 Node 服务执行。桌面壳负责更新检查和本机加密的密码文件。
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" className="shell-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
