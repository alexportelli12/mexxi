// Copy buttons. The page works without this script: the prompts and commands
// are plain text that can be selected and copied by hand.

const status = document.querySelector("[data-copy-status]");

for (const button of document.querySelectorAll(".copy")) {
  const label = button.querySelector(".copy__label");
  let reset;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      label.textContent = "Copied";
      button.dataset.state = "copied";
      status.textContent = "Copied to clipboard";
    } catch {
      label.textContent = "Failed";
      status.textContent = "Copy failed. Select the text and copy it manually.";
    }
    clearTimeout(reset);
    reset = setTimeout(() => {
      label.textContent = "Copy";
      delete button.dataset.state;
      status.textContent = "";
    }, 2000);
  });
}
