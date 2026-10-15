/**
 * Shared test setup: keep every test on the real timers and a clean console.
 *
 * 【初二小白详细通俗讲解】
 * 这个文件是所有单元测试用例公用的"发车前准备站"：
 * - 每一个测试开始前（beforeEach），我们自动戴上"离线头盔"（installDefaultModelsDevMock），
 *   保证测试无论如何也不会偷偷连外网 models.dev，完全使用我们录制好的本地假数据。
 * - 每一个测试结束后（afterEach），我们自动把全局变量打扫得干干净净（vi.unstubAllGlobals），
 *   防止上一个测试留下的垃圾干扰下一个测试。
 */
import { afterEach, beforeEach, vi } from 'vitest'
import { installDefaultModelsDevMock } from './mock-gateway.ts'

beforeEach(() => {
  installDefaultModelsDevMock()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

