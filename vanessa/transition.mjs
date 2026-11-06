export function awaitEditorTransition({ input = process.stdin, output = process.stdout, timeoutMs = 60000, managerPid } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return Promise.reject(new Error("Некорректный срок ожидания перехода в редактор"));
  return new Promise((resolve, reject) => {
    let buffer = "", finished = false, timer;
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer);
      input.removeListener("data", onData); input.removeListener("end", onEnd); input.removeListener("error", onError); input.removeListener("close", onClose);
      input.pause(); input.unref?.();
      error ? reject(error) : resolve();
    };
    const accept = text => {
      let message;
      try { message = JSON.parse(text); } catch { return finish(new Error("Некорректные данные перехода в редактор; требуется точное действие continue")); }
      if (!message || Array.isArray(message) || Object.keys(message).length !== 1 || message.action !== "continue") return finish(new Error("Некорректные данные перехода в редактор; требуется точное действие continue"));
      finish();
    };
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 512) return finish(new Error("Данные перехода в редактор превышают допустимый размер"));
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        if (buffer.slice(newline + 1).trim()) return finish(new Error("Переход в редактор принимает ровно одно сообщение"));
        accept(buffer.slice(0, newline));
      }
    };
    const onEnd = () => buffer.trim() ? accept(buffer) : finish(new Error("Ввод перехода в редактор закрыт до продолжения"));
    const onError = () => finish(new Error("Ошибка ввода перехода в редактор"));
    const onClose = () => finish(new Error("Ввод перехода в редактор закрыт до продолжения"));
    timer = setTimeout(() => finish(new Error("Время перехода в редактор истекло до open_feature_file")), timeoutMs);
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError); input.once("close", onClose);
    output.write(JSON.stringify({ status: "awaiting_editor_enable", ...(managerPid ? { managerPid } : {}),
      action: "Use the independently observed native UI action Перейти в Vanessa Editor, then send exactly one JSON line.",
      input: { action: "continue" }, timeoutMs }) + "\n");
    if (input.readableEnded || input.destroyed) onEnd(); else { input.ref?.(); input.resume(); }
  });
}
