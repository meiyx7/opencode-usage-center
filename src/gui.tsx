import { Command, Plugin, SettingsPage, TitlebarItem } from "@opencode/plugin/gui"
import { onCleanup } from "solid-js"
import { UsageDialog, UsagePage } from "./gui/page"

/**
 * OpenCode's vertical-tabs layout puts plugin titlebar items in a vertical
 * footer (`data-slot="vertical-tabs-footer"`) as 28px circles. With more than
 * one plugin that becomes a stack of unlabeled icons. The host has no
 * orientation option for TitlebarItem, so this shim asks the footer to become
 * a wrapping row with visible labels.
 *
 * 边界（评审 U11）：这是一个兼容层，不是本插件自己的样式——它影响页脚里的
 * 每一个插件入口，包括其他插件的。因此它：
 * - 只在 `options.titlebarLayout !== false` 时安装（用户可用配置关闭）；
 * - 卸载或重载时移除注入的 <style>，不留全局残留；
 * - 仅读取宿主 data-slot，不改写其他插件自己的 DOM。
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

const TITLEBAR_STYLE_ID = "opencode-plugin-titlebar-row"

function installTitlebarLayout(enabled: boolean): void {
  if (typeof document === "undefined") return
  let style = document.getElementById(TITLEBAR_STYLE_ID) as HTMLStyleElement | null
  if (!enabled) {
    style?.remove()
    return
  }
  if (!style) {
    style = document.createElement("style")
    style.id = TITLEBAR_STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = TITLEBAR_CSS
}

export default Plugin.define({
  setup(ctx) {
    // 默认开启以保持现状；用户可在 opencode.json 里用 options.titlebarLayout: false 关闭。
    const enabled = ctx.options.titlebarLayout !== false
    installTitlebarLayout(enabled)
    // 插件卸载/重载时清掉注入的全局样式，别的插件入口回到宿主默认布局。
    if (enabled) {
      onCleanup(() => installTitlebarLayout(false))
    }

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
      title: "用量中心",
      icon: "window-analytics",
      entries: [
        {
          id: "usage-center",
          title: "用量中心",
          description: "Token、费用、OpenCode Go 额度、凭据时效与响应时延",
          keywords: "usage token cost quota subscription latency expiry 用量 用量中心 费用 额度 时延",
        },
      ],
      render: () => <UsagePage ctx={ctx} />,
    })

    // Settings has no persistent sidebar entry for plugin pages; the titlebar pill
    // and shortcut are the always-available ways back to the dashboard.
    ctx.add(TitlebarItem, (): TitlebarItem => ({
      id: "usage",
      label: "用量中心",
      title: "打开用量中心",
      icon: "window-analytics",
      run: open,
    }))

    ctx.add(Command, (): Command => ({
      id: "open",
      title: "用量中心",
      description: "查看 Token、费用、订阅额度与响应时延",
      keywords: "usage token cost quota subscription latency expiry 用量 用量中心 费用 额度 时延",
      group: "设置",
      section: "navigation",
      bind: "mod+alt+u",
      featured: true,
      run: open,
    }))
  },
})
