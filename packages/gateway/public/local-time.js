(() => {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  const formats = {
    minute: new Intl.DateTimeFormat(undefined, options),
    second: new Intl.DateTimeFormat(undefined, {
      ...options,
      second: "2-digit",
    }),
  };

  function format(value, precision = "minute") {
    if (value === undefined || value === null || value === "") return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return (formats[precision] || formats.minute).format(date);
  }

  function localize(node) {
    const text = format(
      node.getAttribute("datetime"),
      node.dataset.timePrecision,
    );
    if (text !== null && node.textContent !== text) node.textContent = text;
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches("[data-local-time]")) localize(root);
    for (const node of root.querySelectorAll("[data-local-time]"))
      localize(node);
  }

  window.devMcpTime = Object.freeze({ format, localize });
  scan(document.body);
  for (const node of document.querySelectorAll("[data-local-timezone]")) {
    node.textContent =
      "시간 표기: " + formats.minute.resolvedOptions().timeZone;
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target.matches("[data-local-time]")) localize(record.target);
        continue;
      }
      const parent =
        record.target.nodeType === 1
          ? record.target
          : record.target.parentElement;
      const time = parent?.closest("[data-local-time]");
      if (time) localize(time);
      for (const node of record.addedNodes) scan(node);
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["datetime", "data-time-precision", "data-local-time"],
  });
})();
