/**
 * Self update check (advisory only).
 *
 * @module @dan-ai-studio/dshopencodego/update
 */

export { PACKAGE_NAME, REGISTRY_LATEST_URL, CHECK_CACHE_MS, CHECK_TIMEOUT_MS } from './check.ts'
export type { UpdateStatus } from './check.ts'
export { compareVersions, createUpdateChecker, isUpdateAvailable, parseLatestVersion, parseVersion } from './check.ts'
export { PLUGIN_VERSION } from './version.ts'
export { OpencodeGoUpdateService } from './service.ts'
export type { UpdateServiceOptions } from './service.ts'
export { parseUpdateStatus, updateRemote } from './contract.ts'
