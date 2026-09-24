/**
 * Copy for the settings page and the usage pill, in both shipped languages.
 *
 * The Harness owns the active locale; this dictionary only supplies the words.
 * Every value is a plain string so the locale service can register it as-is;
 * components compose counts from a number and a unit word.
 *
 * @module @dan-ai-studio/dshopencodego/client/locales
 */

/** English copy, the fallback dictionary. */
export const en = {
  nav: 'OpenCode Go',
  intro: 'OpenCode Go models come from the gateway itself, and every request carries a per-conversation session id.',
  keyTitle: 'API key',
  keyHint: 'Stored write-only in the Harness credential store under OPENCODE_GO_API_KEY.',
  keyConfigured: 'Configured',
  keyMissing: 'Not configured',
  keyPlaceholder: 'Paste the OpenCode Go API key',
  keySave: 'Save key',
  keyClear: 'Remove key',
  keySaved: 'Saved',
  catalogTitle: 'Models',
  catalogRefresh: 'Refresh',
  catalogSelectAll: 'Select all',
  catalogSelectNone: 'Select none',
  catalogStale: 'Showing the last successful listing',
  catalogCountUnit: 'models',
  catalogInferred: 'protocol inferred',
  catalogAssumed: 'default capacities',
  catalogDeprecated: 'deprecated',
  catalogUnconfigured: 'not configurable',
  refreshLabel: 'Catalog refresh (minutes)',
  refreshHint: 'How long requests and the model picker reuse one listing.',
  writeRejected: 'The settings write was rejected (the namespace was reloaded) — try again',
  writeFailed: 'The settings write failed',
  usageTitle: 'OpenCode Go usage',
  usageRolling: '5 hours',
  usageWeekly: 'Week',
  usageMonthly: 'Month',
  usageResets: 'Resets',
  usageLimited: 'rate limited',
  usageUnavailable: 'unavailable',
  usageStale: 'stale',
  usageRetry: 'Retry',
  usageRefreshing: 'Refreshing…',
  usageLastUpdated: 'Updated',
  usageSinceBoot: 'Since this Harness started',
  usageCallsUnit: 'calls',
  usageTokensUnit: 'tokens',
  usageCached: 'cached read',
  usageLocalHint: 'The gateway publishes quota percentages only; token counts are what this process actually spent.',
  usageLoading: 'Loading…',
} as const

/** Simplified Chinese copy. */
export const zh: Record<keyof typeof en, string> = {
  nav: 'OpenCode Go',
  intro: 'OpenCode Go 的模型列表直接来自网关，且每个请求都会携带按会话稳定的会话 ID。',
  keyTitle: 'API Key',
  keyHint: '以只写方式保存在 Harness 凭证库中，引用名为 OPENCODE_GO_API_KEY。',
  keyConfigured: '已配置',
  keyMissing: '未配置',
  keyPlaceholder: '粘贴 OpenCode Go API Key',
  keySave: '保存 Key',
  keyClear: '移除 Key',
  keySaved: '已保存',
  catalogTitle: '模型',
  catalogRefresh: '刷新',
  catalogSelectAll: '全选',
  catalogSelectNone: '全不选',
  catalogStale: '当前显示的是上次成功获取的列表',
  catalogCountUnit: '个模型',
  catalogInferred: '协议为推断',
  catalogAssumed: '容量为默认值',
  catalogDeprecated: '已弃用',
  catalogUnconfigured: '无法配置',
  refreshLabel: '目录刷新（分钟）',
  refreshHint: '请求与模型选择器复用同一份列表的时长。',
  writeRejected: '设置写入被拒绝（已重新载入），请重试',
  writeFailed: '设置写入失败',
  usageTitle: 'OpenCode Go 用量',
  usageRolling: '5 小时',
  usageWeekly: '本周',
  usageMonthly: '本月',
  usageResets: '重置',
  usageLimited: '已限流',
  usageUnavailable: '不可用',
  usageStale: '陈旧',
  usageRetry: '重试',
  usageRefreshing: '刷新中…',
  usageLastUpdated: '更新于',
  usageSinceBoot: '自本次 Harness 启动以来',
  usageCallsUnit: '次调用',
  usageTokensUnit: 'tokens',
  usageCached: '缓存读取',
  usageLocalHint: '网关只公布额度百分比；token 数为本进程实际消耗。',
  usageLoading: '加载中…',
}

/** Every key this plugin can translate. */
export type OpencodeGoKey = keyof typeof en
