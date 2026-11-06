import { Command, Plugin, SettingsPage, TitlebarItem } from "@opencode/plugin/gui"
import { UsageDialog, UsagePage } from "./gui/page"

export default Plugin.define({
  setup(ctx) {
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
