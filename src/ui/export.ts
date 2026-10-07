import { api } from "./api.js";
import { h, dialog } from "./dom.js";
import { state } from "./state.js";

export async function exportDialog(): Promise<void> {
  const status = h("p", { class: "muted", role: "status" }, "Preparing Markdown…");
  const content = h("div", null, h("h3", null, "Export for agent"), status);
  const modal = dialog(content);
  try {
    const result = await api.export(state.id, state.data!.revision);
    const preview = h(
      "textarea",
      {
        class: "export-preview mono",
        id: "export-markdown",
        "aria-label": "Exported Markdown",
        readonly: true,
      },
      result.markdown,
    );
    status.textContent = `${result.threads} feedback items · ${result.open} unresolved`;
    content.append(
      preview,
      h(
        "div",
        { class: "row export-actions" },
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(result.markdown);
                status.textContent = "Copied to clipboard.";
              } catch {
                preview.focus();
                preview.select();
                status.textContent = "Clipboard unavailable. Copy the selected Markdown manually.";
              }
            },
          },
          "Copy to clipboard",
        ),
        h(
          "button",
          {
            onclick: () => {
              const url = URL.createObjectURL(
                new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }),
              );
              const link = h("a", { href: url, download: result.filename });
              document.body.append(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            },
          },
          "Download .md",
        ),
        h("button", { class: "ghost", onclick: () => modal.close() }, "Close"),
      ),
    );
  } catch (e) {
    status.textContent = `Export failed: ${(e as Error).message}`;
  }
}
