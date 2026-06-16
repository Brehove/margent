function setTemporaryText(element, text, delay = 1600) {
  const originalText = element.textContent || "";
  element.textContent = text;
  window.setTimeout(() => {
    element.textContent = originalText;
  }, delay);
}

async function copyText(text, control, fallbackElement = control) {
  try {
    await navigator.clipboard.writeText(text);
    setTemporaryText(control, "Copied");
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(fallbackElement);
    selection?.removeAllRanges();
    selection?.addRange(range);
    setTemporaryText(control, "Selected", 2200);
  }
}

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    void copyText(target.textContent.trim(), button, target);
  });
});

document.querySelectorAll("[data-copy-value]").forEach((button) => {
  button.addEventListener("click", () => {
    const text = button.getAttribute("data-copy-value");
    const label = button.querySelector("span") || button;
    if (!text) return;
    void copyText(text, label, button);
  });
});
