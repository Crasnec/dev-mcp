(() => {
  const messages = Array.from(document.querySelectorAll(".notice"));
  if (messages.length > 0) {
    const url = new URL(window.location.href);
    if (url.searchParams.delete("saved")) {
      window.history.replaceState(
        null,
        "",
        url.pathname + url.search + url.hash,
      );
    }
  }
  const dialogs = messages.map((message, index) => {
    const dialog = document.createElement("dialog");
    const panel = document.createElement("div");
    const heading = document.createElement("div");
    const icon = document.createElement("span");
    const title = document.createElement("h2");
    const closeForm = document.createElement("form");
    const closeButton = document.createElement("button");
    const titleId = `message-dialog-title-${index}`;
    const bodyId = `message-dialog-body-${index}`;

    dialog.className = "message-dialog";
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", bodyId);
    panel.className = "message-dialog-panel";
    heading.className = "message-dialog-heading";
    icon.className = "message-dialog-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "i";
    title.id = titleId;
    title.textContent = "알림";
    message.id = bodyId;
    message.classList.remove("notice");
    message.classList.add("message-dialog-body");
    message.removeAttribute("role");
    closeForm.className = "message-dialog-actions";
    closeForm.method = "dialog";
    closeButton.type = "submit";
    closeButton.className = "message-dialog-close";
    closeButton.textContent = "확인";

    heading.append(icon, title);
    closeForm.append(closeButton);
    panel.append(heading, message, closeForm);
    dialog.append(panel);
    document.body.append(dialog);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
    return dialog;
  });

  let next = 0;
  const showNext = () => {
    const dialog = dialogs[next++];
    if (!dialog) {
      return;
    }
    dialog.addEventListener("close", showNext, { once: true });
    dialog.showModal();
  };
  showNext();
})();
