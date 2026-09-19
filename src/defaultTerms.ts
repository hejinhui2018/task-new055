import type { Term } from './types'

/**
 * 节目预置术语表（品牌名 / 产品型号 / 写法规范）。
 *
 * 运营可在此基础上新增或更新：每次更新都会产生新版本号，
 * 旧建议失效并重扫。预置术语故意覆盖四类结果，便于演练：
 *   - 可自动建议：「晚间新闻→《晚间新闻》」「新闻→资讯」「X90→X90 Pro」「北京时间→北京时间（BJT）」
 *   - 同音歧义：「新闻」登记同音词「欣闻」，#101 出现「欣闻」时只提示不自动改
 *   - 重叠术语：「晚间新闻」比「新闻」更长，同区间命中时长词优先，短词转人工确认
 *   - 不适用：「摘要」限说话人「陈默」、「观众」限 +4s 之后生效，与片段范围不匹配
 */
export const DEFAULT_TERMS: Term[] = [
  {
    id: 't-evening-news',
    version: 1,
    source: '晚间新闻',
    target: '《晚间新闻》',
    lang: 'zh-CN',
    enabled: true,
  },
  {
    id: 't-news',
    version: 2,
    source: '新闻',
    target: '资讯',
    lang: 'zh-CN',
    homophones: ['欣闻'],
    enabled: true,
  },
  {
    id: 't-x90',
    version: 3,
    source: 'X90',
    target: 'X90 Pro',
    enabled: true,
  },
  {
    id: 't-zhaiyao',
    version: 4,
    source: '摘要',
    target: '摘要播报',
    lang: 'zh-CN',
    speakers: ['陈默'],
    enabled: true,
  },
  {
    id: 't-audience',
    version: 5,
    source: '观众',
    target: '观众朋友',
    lang: 'zh-CN',
    validFromMs: 4000,
    enabled: true,
  },
  {
    id: 't-beijing',
    version: 6,
    source: '北京时间',
    target: '北京时间（BJT）',
    enabled: true,
  },
]

/** 预置术语占用的最新版本号；之后的新建/更新从 7 开始 */
export const DEFAULT_TERM_VERSION = DEFAULT_TERMS.length
