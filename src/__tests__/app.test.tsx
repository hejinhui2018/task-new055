import { beforeAll, describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'

// App 初始化时会访问 localStorage 做刷新恢复，node 环境下先打桩
beforeAll(() => {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  })
})

describe('App 装配冒烟', () => {
  it('初始状态可完整服务端渲染，包含术语表、建议面板与原有三栏', async () => {
    const { default: App } = await import('../App')
    const html = renderToString(<App />)
    // 新增的版本化术语校对区块
    expect(html).toContain('节目术语表')
    expect(html).toContain('术语校对建议')
    expect(html).toContain('批量接受全部建议')
    // 内置演示术语
    expect(html).toContain('晚间新闻')
    // 原有流程区块仍然在位
    expect(html).toContain('字幕校对台')
    expect(html).toContain('直播预览')
    expect(html).toContain('字幕时间线')
    expect(html).toContain('事件流')
  })
})
