const copyButton = document.querySelector("[data-copy-prompt]");
const promptBlock = document.querySelector("#install-prompt");

async function copyInstallPrompt() {
  if (!copyButton || !promptBlock) return;

  const originalText = copyButton.textContent || "Copy";
  const promptText = promptBlock.textContent.trim();

  try {
    await navigator.clipboard.writeText(promptText);
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = originalText;
    }, 1800);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(promptBlock);
    selection?.removeAllRanges();
    selection?.addRange(range);
    copyButton.textContent = "Selected";
    window.setTimeout(() => {
      copyButton.textContent = originalText;
    }, 2200);
  }
}

copyButton?.addEventListener("click", () => {
  void copyInstallPrompt();
});
