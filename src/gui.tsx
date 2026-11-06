import { Command, Plugin, SettingsPage, TitlebarItem } from "@opencode/plugin/gui"
import { UsageDialog, UsagePage } from "./gui/page"

/**
 * OpenCode's vertical-tabs layout puts plugin titlebar items in a vertical
 * footer (`data-slot="vertical-tabs-footer"`) as 28px circles. With more than
 * one plugin that becomes a stack of unlabeled icons. The host has no
 * orientation option for TitlebarItem, so make that footer a wrapping row and
 * keep each item's own label visible. This applies to every plugin item in the
 * footer, including the plugin hub's.
 */
const TITLEBAR_CSS = `
[data-slot="vertical-tabs-footer"] {
  flex-direction: row !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 6px !important;
}
[data-slot="vertical-tabs-footer"] [data-slot="titlebar-update"] {
  width: auto !important;
  height: 28px !important;
  max-width: 100% !important;
  align-self: center !important;
}
[data-slot="vertical-tabs-footer"] [data-slot="titlebar-update"] > button {
  justify-content: flex-start !important;
  padding-inline-end: 2px !important;
}
[data-slot="vertical-tabs-footer"] [data-slot="titlebar-update-label"] {
  opacity: 1 !important;
  transform: none !important;
  margin-inline-start: 6px !important;
  margin-inline-end: 8px !important;
}
`

function installTitlebarLayout() {
  if (typeof document === "undefined") return
  const id = "opencode-plugin-titlebar-row"
  let style = document.getElementById(id) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement("style")
    style.id = id
    document.head.appendChild(style)
  }
  style.textContent = TITLEBAR_CSS
}

export default Plugin.define({
  setup(ctx) {
    installTitlebarLayout()

    // One entry point for the titlebar pill and the global shortcut: a standalone
    // x-large dialog, so the dashboard is not only a tab buried inside Settings.
    const open = () => {
      if (ctx.dialogs.active()) return
      ctx.dialogs.open((dialog) => (
        <UsageDialog ctx={ctx} onClose={() => dialog.close()} />
      ))
    }

    ctx.add(SettingsPage, {
      id: "usage-center",
      title: "模型用量",
      icon: "window-analytics",
      entries: [
        {
          id: "usage-center",
          title: "模型用量",
          description: "Token、费用、OpenCode Go 额度、凭据时效与响应时延",
          keywords: "usage token cost quota subscription latency expiry 用量 费用 额度 时延",
        },
      ],
      render: () => <UsagePage ctx={ctx} />,
    })

    // Settings has no persistent sidebar entry for plugin pages; the titlebar pill
    // and shortcut are the always-available ways back to the dashboard.
    ctx.add(TitlebarItem, (): TitlebarItem => ({
      id: "usage",
      label: "用量",
      title: "打开模型用量",
      icon: "window-analytics",
      run: open,
    }))

    ctx.add(Command, (): Command => ({
      id: "open",
      title: "模型用量",
      description: "查看 Token、费用、订阅额度与响应时延",
      keywords: "usage token cost quota subscription latency expiry 用量 费用 额度 时延",
      group: "设置",
      section: "navigation",
      bind: "mod+alt+u",
      featured: true,
      run: open,
    }))
  },
})
