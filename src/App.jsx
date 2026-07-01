import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  FormTitle,
  Icon,
  Input,
  Modal,
  Tag,
  Toast,
} from '@tfdesign/b-end';

/* ============================================================================
 * 工单 AI 工作台 · 坐席操作台（对话式）
 * 顶栏 + 左栏分诊台 + 中栏作战图 + 右栏辅助信息（Trae 式工具面板）
 * 中栏「作战图」自上而下完成一次介入闭环（无独立执行节点带）：
 *   工单头（标题/状态/工单号；场景·金额·商家·诉求等元信息归右栏摘要）
 *   → 对话流（经过 · 明细）：关键结论 + 思考过程默认收起 + 异常气泡「为什么停 → 下一步」
 *   → 决策卡（卡点 → 依据 → 操作）：红顶条决策问题 + AI 建议/置信度 + 可溯源依据 + 强权重主操作
 *   → 底部唯一指令框 + 快捷 chips
 * 颜色 / 间距 / 圆角 / 字号走 TF_Base token。
 * ==========================================================================*/

/* ── 状态语义 ── */
const NODE_STATUS = {
  done: { label: '已完成', dot: 'bg-green-500', tag: 'green', icon: 'check-circle-stroked' },
  exception: { label: '异常', dot: 'bg-red-500', tag: 'red', icon: 'alert-triangle-stroked' },
  waiting: { label: '等待中', dot: 'bg-orange-500', tag: 'orange', icon: 'clock-stroked' },
  running: { label: '进行中', dot: 'bg-blue-500', tag: 'blue', icon: 'refresh-cw-01-stroked' },
};

const SLA_LEVEL = { safe: 'bg-green-500', warning: 'bg-orange-500', critical: 'bg-red-500' };
const SLA_TEXT = { safe: 'text-green-600', warning: 'text-orange-600', critical: 'text-red-600' };

/* 高风险免审上限：超过则强制走上级审批 */
const APPROVAL_LIMIT = 500;

/* ── Mock：对话流（AI 节点只暴露关键结论，thinking=思考过程默认收起） ── */
const CHAT = [
  { id: 'm-user', role: 'user', name: '李女士', time: '14:00', text: '商家一直没处理，我等一天了，要求退款 ¥387。' },
  { id: 'm-plan', role: 'ai', name: 'Ticko', time: '14:00', text: '已拆解任务：判责 → 外呼催办 → 退款关单，按因果顺序执行。',
    thinking: '识别诉求＝退款 ¥387；拉取订单 HT-20260623-0387，状态＝待商家处理；按「先判责、后执行」原则拆解为 判责 → 外呼催办 → 退款关单 三步。' },
  { id: 'm-judge', role: 'ai', name: 'Ticko', time: '14:01', text: '判责完成：商家未按约履约，判定为商家责任。证据链完整。',
    thinking: '比对履约记录：商家应在 24h 内响应，实际超时未处理；命中规则 R-refund-07；订单 / 会话 / 超时三项证据齐全 → 判定商家责任，置信度 72%。' },
  { id: 'm-call', role: 'ai', name: 'Ticko', time: '14:21', exception: true, text: '外呼催办异常：14:02 / 14:21 两次外呼商家均未接听，已耗尽自动重试。', caption: '为什么停：商家拒接 → 下一步：需你决策',
    thinking: '14:02 首次外呼→未接（响铃 30s）；14:21 二次外呼→未接；自动重试策略上限＝2 次，已耗尽；无法自动推进，移交人工决策。' },
];

/* ── Mock：待决策方案 ──
 *   confidenceLevel：high(≥85) / mid(60-85) / low(<60) → 自动映射 Tag 颜色
 *   riskFlags：风险标注那一行的少量关键标签（"敢不敢执行"的最后一道判断） */
const CONF_VARIANT = { high: 'green', mid: 'orange', low: 'red' };
const CONF_LABEL = { high: '高', mid: '中', low: '低' };
const DECISION = {
  question: '商家两次外呼均未接听、自动重试已耗尽，是否由平台垫付退款并关单？',
  recommendation: '垫付退款 ¥387 并关单',
  baseAmount: 387,
  confidence: 72,
  confidenceLevel: 'mid',
  responsibility: '商家责任',
  recoverable: '可追偿，回收周期约 7 天',
  alternative: '再次人工外呼 / 升级商家运营',
  riskFlags: [
    { label: '高风险', tone: 'red' },
    { label: '资金不可逆', tone: 'red' },
    { label: '可追偿', tone: 'green' },
  ],
};

/* ③ 决策级依据：直接支撑本次建议的少数关键事实（搬入中栏，贴着决策点）。
 *   anchor：可溯源到执行链对应节点；深度材料（完整日志/订单/商家详情）仍留侧栏抽屉。*/
const DECISION_EVIDENCE = [
  { text: '判责结论＝商家责任，证据链完整', anchor: 'm-judge' },
  { text: '商家 14:02 / 14:21 两次拒接，超时未响应', anchor: 'm-call' },
  { text: '¥387 在 ¥500 免审上限内，可直接垫付', anchor: null },
];

/* ── Mock：右栏辅助信息（三类，点击图标才展开抽屉，非常驻） ──
 * 1. 摘要：工单维度（用户问题/诉求/处理方案）+ 任务维度（agent 进展精简摘要，不复刻中栏执行链）
 * 2. 日志：工单全生命周期时间轴
 * 3. 用户上下文：进线前 IM + 该用户的相似工单 */

/* 第一类·工单维度 */
const TICKET_SUMMARY = [
  { label: '场景', value: '酒店退款 · 仲裁退款' },
  { label: '金额', value: '¥387' },
  { label: '商家', value: '喏布渔民宿' },
  { label: '用户问题', value: '预订后商家迟迟未确认，入住日期临近仍无回应。' },
  { label: '用户诉求', value: '要求全额退款 ¥387，原路退回。' },
  { label: '处理方案', value: '判责商家责任 → 外呼催办（已失败）→ 拟平台垫付退款并关单。' },
];
/* 第一类·任务维度（精简摘要：阶段 / 进度 / 卡点，链路明细在中栏） */
const TASK_SUMMARY = {
  stage: '外呼催办',
  progress: '4 步中第 3 步',
  state: '异常 · 已停',
  note: '自动重试已耗尽，等待人工决策是否垫付。',
};

/* 第二类·工单日志（时间轴） */
const TICKET_LOG = [
  { time: '13:32', actor: 'AI', text: '工单进线，识别诉求＝退款 ¥387，自动拆解处理计划。' },
  { time: '14:00', actor: 'AI', text: '判责完成：商家责任，证据链完整（置信度 72%）。' },
  { time: '14:02', actor: 'AI', text: '首次外呼商家 → 未接听（响铃 30s）。' },
  { time: '14:21', actor: 'AI', text: '二次外呼商家 → 未接听，自动重试耗尽，转人工决策。' },
];

/* 第三类·用户上下文 */
const USER_IM_LOG = [
  { time: '昨天 21:40', text: '我订的房间到现在商家还没确认，怎么回事？' },
  { time: '昨天 21:42', text: '客服回复：已为您催促商家，请耐心等待。' },
  { time: '今天 13:30', text: '等了一天了还没处理，我要退款！' },
];
const USER_SIMILAR_TICKETS = [
  { code: 'HT-20260415-0211', scene: '酒旅·仲裁退款', result: '商家责 · 垫付退款', time: '04-15' },
  { code: 'HT-20260308-0190', scene: '酒旅·订单改签', result: '已改签完成', time: '03-08' },
];

/* ── Mock：左栏工单 ──
 * priority：组内强制排序键（小=更急），驱动「先干预哪一个」。仅「需介入」组按其升序排，最急置顶并标①②③。
 * badge：当前状态摘要（随分组着色：需介入红 / 托管中蓝 / 已完成灰）。
 * summary / aiNode / aiState 的卡片展示按工单状态分流：
 *   - 需介入组：展示 summary=介入原因（红色驱动行动）。
 *   - 托管中组：展示 aiNode/aiState=当前 AI 节点状态（进度主语）+ summary（muted 补充）。
 *   - 已完成组：仅状态摘要，不再展开。*/
const TICKETS = [
  { id: 't1', code: '2918575148379876', scene: '酒旅·仲裁退款', amount: '¥387', amountNum: 387,
    title: '售后追单 · 商家拒接', group: '需介入', status: 'exception',
    priority: 0, priorityReason: 'SLA<2min · 已耗尽自动重试',
    aiNode: '外呼 subagent', aiState: '已停',
    badge: '待处理 · 确认外呼脚本',
    summary: '外呼失败 2 次，已耗尽自动重试，需人工决策下一步。',
    sla: { level: 'critical', percent: 92, countdown: '01:58' },
    tags: ['需首呼', '催4', '高优'], takenOver: false, time: '13:32' },

  { id: 't3', code: '2918575148366540', scene: '酒旅·大额退款', amount: '¥1,280', amountNum: 1280,
    title: '整单退款 · 金额超限', group: '需介入', status: 'waiting',
    priority: 1, priorityReason: 'SLA<5min · 金额超限待审批',
    aiNode: '审批 subagent', aiState: '待审批',
    badge: '待处理 · 选择方案',
    summary: '退款金额超免审上限（>¥500），需上级审批后执行。',
    sla: { level: 'critical', percent: 88, countdown: '03:12' },
    tags: ['超限', '高金额', '高优'], takenOver: false, time: '13:05' },

  { id: 't2', code: '2918575148370012', scene: '酒旅·仲裁退款', amount: '¥240', amountNum: 240,
    title: '退款金额确认 · 置信度低', group: '需介入', status: 'waiting',
    priority: 2, priorityReason: '置信度低 · SLA 12min',
    aiNode: '核验 subagent', aiState: '待确认',
    badge: '待处理 · 确认金额',
    summary: '判责置信度 58% 偏低，需人工确认退款金额后放行。',
    sla: { level: 'warning', percent: 64, countdown: '12:30' },
    tags: ['置信低', '催2'], takenOver: true, time: '13:18' },

  { id: 't4', code: '2918575148351299', scene: '酒旅·订单改签', amount: '¥0', amountNum: 0,
    title: '入住日期改签 · 进行中', group: '托管中', status: 'running',
    priority: 10, priorityReason: null,
    aiNode: '改签 subagent', aiState: '运行中',
    badge: '托管中',
    summary: '正在与商家核对可改签房态，预计 2 分钟内完成。',
    sla: { level: 'safe', percent: 28, countdown: '46:10' },
    tags: ['催1'], takenOver: true, time: '12:40' },

  { id: 't5', code: '2918575148347781', scene: '酒旅·发票补开', amount: '¥0', amountNum: 0,
    title: '增值税发票补开 · 已开具', group: '已完成', status: 'done',
    priority: 20, priorityReason: null,
    aiNode: '开票 subagent', aiState: '已完成',
    badge: '已完成',
    summary: '发票已开具并回传用户，工单自动关单。',
    sla: { level: 'safe', percent: 100, countdown: '00:00' },
    tags: ['已闭环'], takenOver: false, time: '昨天' },
];

/* 多选筛选 chips：'全部' 为重置项（filters 为空即视为全部）；可 by 业务线按需增加 */
const FILTER_DEFS = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '需我介入' },
  { key: 'taken', label: '我接管的' },
  { key: 'sla30', label: 'SLA < 30min' },
];
const matchFilter = (t, key) => {
  switch (key) {
    case 'mine': return t.group === '需介入';
    case 'taken': return t.takenOver;
    case 'sla30': return Number(t.sla.countdown.split(':')[0]) < 30;
    default: return true;
  }
};

const GROUP_ORDER = ['需介入', '托管中', '已完成'];
const GROUP_META = {
  '需介入': { dot: 'bg-red-500', tone: 'text-red-600', badge: 'bg-red-50 text-red-600' },
  '托管中': { dot: 'bg-blue-500', tone: 'text-foreground-secondary', badge: 'bg-blue-50 text-blue-600' },
  '已完成': { dot: 'bg-green-500', tone: 'text-foreground-muted', badge: 'bg-blueGrey-100 text-foreground-muted' },
};

/* ── 底栏 · 工具与 chat ──
 * 接管态机：ownership = 'ai' | 'human'
 *   - ai（默认）：工具行整体灰禁，hover 提示「需先接管」；chat 主模式＝对 Agent 说
 *   - human：工具行激活、底栏整体琥珀色高亮；chat 主模式仍可用，但「对 Agent 说」语义弱化为「让 AI 协助」
 * 工具分两层：
 *   - 主工具（PRIMARY_TOOLS）：高频，平铺在底栏第二行
 *   - 辅助工具（MORE_TOOLS）：低频，「更多工具」抽屉里展开
 * 副作用等级 effect：'high'（外呼/退款/通信/关单 → 二次确认）| 'low'（转单/催办/挂起 → 直接执行）| 'none'（备注/标签/查询 → 直接执行）
 */
const PRIMARY_TOOLS = [
  { key: 'call', label: '外呼商家', icon: 'phone-call-01-stroked', effect: 'high', desc: '拨打商家电话 0883-****216' },
  { key: 'sms', label: '发短信', icon: 'message-square-01-stroked', effect: 'high', desc: '向商家/用户发送短信' },
  { key: 'refund', label: '发起退款', icon: 'currency-yen-stroked', effect: 'high', desc: '原路退回/垫付，资金动作不可逆' },
  { key: 'coupon', label: '发券补偿', icon: 'gift-01-stroked', effect: 'high', desc: '向用户发放补偿券' },
  { key: 'transfer', label: '转单', icon: 'switch-horizontal-01-stroked', effect: 'low', desc: '将工单转给其他坐席' },
  { key: 'note', label: '备注', icon: 'edit-02-stroked', effect: 'none', desc: '添加工单内部备注' },
];
const MORE_TOOLS = [
  { key: 'merchant', label: '商家档案', icon: 'building-02-stroked', effect: 'none', desc: '查看商家完整档案' },
  { key: 'order', label: '订单详情', icon: 'shopping-cart-01-stroked', effect: 'none', desc: '查看订单完整字段' },
  { key: 'urge', label: '催办', icon: 'notification-message-stroked', effect: 'low', desc: '催商家响应' },
  { key: 'snooze', label: '挂起', icon: 'clock-snooze-stroked', effect: 'low', desc: '挂起工单等待外部回执' },
  { key: 'human', label: '转人工', icon: 'user-right-01-stroked', effect: 'low', desc: '转给上级坐席/专家' },
  { key: 'tag', label: '加标签', icon: 'tag-01-stroked', effect: 'none', desc: '为工单打业务标签' },
  { key: 'close', label: '关单', icon: 'x-close-stroked', effect: 'high', desc: '关闭工单' },
  { key: 'attach', label: '附件', icon: 'file-plus-01-stroked', effect: 'none', desc: '上传图片/文档作为证据' },
];

/* chat 模式：
 *   cmd    ：对 Agent 说（指令）→ 进入中栏对话流，留痕；副作用指令拦二次确认
 *   search ：AI 搜（查询）→ 结果落在底栏上方临时浮层，不污染中栏时间线 */
const CHAT_MODES = [
  { key: 'cmd', label: '对 Agent 说', icon: 'cpu-chip-01-stroked', placeholder: '告诉 AI 怎么处理这张单 / 调整流程 / 追问依据…' },
  { key: 'search', label: 'AI 搜', icon: 'search-md-stroked', placeholder: '查商家 / 订单 / 政策 / 历史相似单…' },
];

/* 快捷 chips：随模式切换，降低高频输入成本 */
const QUICK_ACTIONS_BY_MODE = {
  cmd: [
    { label: '改垫付金额', fill: '把垫付金额改为 ¥' },
    { label: '重新外呼', fill: '让 AI 重新外呼商家一次' },
    { label: '先别退款', fill: '先暂停退款流程，等我再确认。' },
    { label: '追问依据', fill: '为什么判定为商家责任？' },
  ],
  search: [
    { label: '查商家档案', fill: '查 喏布渔民宿 近 30 天投诉/退款情况。' },
    { label: '查相似单', fill: '近 30 天有哪些「商家拒接 + 仲裁退款」的相似单？' },
    { label: '查政策', fill: '酒店类目仲裁退款的免审上限和回收政策？' },
    { label: '查订单原文', fill: '订单 HT-20260623-0387 完整字段是什么？' },
  ],
};

/* 指令副作用判定：纯流程调整（"先别退款"、"暂停"、"再确认"）不拦；
 * 涉及外呼 / 短信 / 发券 / 退款 / 关单等真实动作 → 二次确认。 */
const CMD_HIGH_EFFECT_RE = /(外呼商家|外呼一次|发短信|发短信通知|发券|补偿券|垫付|退款给|关单|关闭工单)/;
const isHighEffectCmd = (text) => CMD_HIGH_EFFECT_RE.test(text);

/* AI 搜 mock：根据查询语义返回 2-3 条带来源的结果 */
const SEARCH_MOCK = {
  '商家': [
    { title: '喏布渔民宿 · 近 30 天指标', body: '投诉 4 单 / 退款 6 单（垫付 2）/ 平均响应 6.3h / 拒接率 18%。', source: '商家档案 · MK-339201' },
    { title: '历史承接率', body: '酒店仲裁退款历史承接率 73%，本商家近 30 天承接率 41%（低）。', source: '商家档案 · 履约页签' },
  ],
  '相似': [
    { title: '近 30 天 8 单「商家拒接 + 仲裁退款」', body: '7 单走垫付、1 单升级商家运营；平均处理时长 18 分钟；坐席满意度 92%。', source: '相似单 · 检索 #SR-2607' },
  ],
  '政策': [
    { title: '酒店类目仲裁退款 · 免审与回收', body: '单笔 ¥500 以内可由坐席直接垫付，无需审批；超限走上级审批；回收周期 7 个工作日。', source: '政策 · POL-Refund-07' },
  ],
  '订单': [
    { title: '订单 HT-20260623-0387', body: '入住 2026-06-23、共 2 晚、间夜价 ¥193.5、合计 ¥387，状态＝待商家处理。', source: '订单系统 · 完整字段' },
  ],
};
const matchSearch = (query) => {
  const hit = Object.entries(SEARCH_MOCK).find(([k]) => query.includes(k));
  return hit ? hit[1] : [
    { title: '未命中本地缓存', body: '将转后端检索，预计 1-2s 返回。本演示页面暂用 mock 数据。', source: '系统' },
  ];
};

/* ── 顶栏 ── */
function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border-default bg-surface px-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-700">
          <Icon name="layout-alt-01-stroked" size="sm" />
        </span>
        <FormTitle variant="form" title="工单 AI 工作台" />
        <Tag variant="teal" size="s" className="ml-1">酒店 · 仲裁退款</Tag>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs leading-4 [font-weight:var(--font-medium)] text-brand-700">
          <Icon name="cpu-chip-01-stroked" size="xs" />在线托管 · 工单托管
        </span>
        <span className="relative">
          <Button variant="ghost-black" iconOnly icon={<Icon name="bell-01-stroked" size="md" />} tooltip="通知" />
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-xs leading-none text-foreground-inverse [font-weight:var(--font-semibold)]">3</span>
        </span>
        <span className="inline-flex items-center gap-2 rounded-full bg-blueGrey-100 py-1 pl-1 pr-3">
          <span className="relative inline-flex">
            <Avatar type="ch" label="张三" size="xs" />
            <span className="absolute -bottom-0 -right-0 h-2.5 w-2.5 rounded-full border-2 border-surface bg-green-500" />
          </span>
          <span className="text-sm leading-5 [font-weight:var(--font-medium)] text-foreground">张三 · 在线</span>
        </span>
      </div>
    </header>
  );
}

/* ── 左栏 · 分诊台 ── */
function SlaBar({ sla }) {
  return (
    <div className="flex items-center gap-2">
      <Icon name="clock-stroked" size="xs" className={`shrink-0 ${SLA_TEXT[sla.level]}`} />
      <span className={`shrink-0 text-xs leading-4 [font-weight:var(--font-semibold)] ${SLA_TEXT[sla.level]}`}>{sla.countdown}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-blueGrey-200">
        <div className={`h-full rounded-full ${SLA_LEVEL[sla.level]}`} style={{ width: `${sla.percent}%` }} />
      </div>
    </div>
  );
}

const RANK_GLYPH = ['①', '②', '③', '④', '⑤'];

function TicketItem({ ticket, rank, isTop, selected, onSelect }) {
  const needAction = ticket.group === '需介入';
  const hosting = ticket.group === '托管中';
  return (
    <button
      type="button"
      onClick={() => onSelect(ticket.id)}
      className={[
        'group w-full rounded-lg border p-3 text-left transition-colors',
        // 视觉权重：需介入 #1 卡更重（红边条加粗），其余需介入卡红细条，托管/已完成无强调
        isTop ? 'border-l-[4px] border-l-red-500' : needAction ? 'border-l-[3px] border-l-red-300' : 'border-l-[3px] border-l-transparent',
        selected
          ? 'border-border-default !border-l-brand-500 bg-surface shadow-sm'
          : isTop
            ? 'border-transparent bg-red-50 hover:bg-red-100'
            : 'border-transparent bg-blueGrey-100 hover:bg-blueGrey-200',
      ].join(' ')}
    >
      {/* 行1：优先级序号（仅需介入）+ 场景标题 + 弱化ID（hover 展开） */}
      <div className="flex items-center gap-2">
        {needAction && (
          <span className={`shrink-0 text-sm leading-5 [font-weight:var(--font-semibold)] ${isTop ? 'text-red-600' : 'text-foreground-muted'}`}>{RANK_GLYPH[rank]}</span>
        )}
        <Avatar type="ch" label={ticket.scene.slice(-2)} size="xs" className="shrink-0" />
        <span className="truncate text-sm leading-5 [font-weight:var(--font-semibold)] text-foreground">{ticket.scene}</span>
        <span className="ml-auto flex shrink-0 items-center text-foreground-disabled" title={`工单号 ${ticket.code}`}>
          <Icon name="hash-01-stroked" size="xs" />
          <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs leading-4 opacity-0 transition-all duration-200 group-hover:ml-0.5 group-hover:max-w-[130px] group-hover:opacity-100">{ticket.code}</span>
        </span>
      </div>

      {/* 行2：当前状态摘要（状态色随分组：需介入红 / 托管中蓝 / 已完成灰） */}
      <div className="mt-2 flex items-center gap-1.5">
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs leading-4 [font-weight:var(--font-medium)] ${GROUP_META[ticket.group].badge}`}>{ticket.badge}</span>
      </div>

      {/* 行3：按状态展示
           - 需介入：介入原因摘要（红色，驱动行动）
           - 托管中：当前 AI 节点状态（进度主语）+ 进展摘要（muted）
           - 已完成：不展示（状态摘要已说明，无需介入原因 / 无运行中节点） */}
      {needAction && (
        <div className="mt-2 flex items-start gap-1.5">
          <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${NODE_STATUS[ticket.status].dot}`} />
          <p className="min-w-0 text-xs leading-4 [font-weight:var(--font-medium)] text-red-600">{ticket.summary}</p>
        </div>
      )}
      {hosting && (
        <div className="mt-2 flex items-start gap-1.5">
          <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${NODE_STATUS[ticket.status].dot} ${ticket.status === 'running' ? 'animate-pulse' : ''}`} />
          <p className="min-w-0 text-xs leading-4">
            <span className="[font-weight:var(--font-semibold)] text-foreground-secondary">{ticket.aiNode} · {ticket.aiState}</span>
            <span className="text-foreground-muted"> · {ticket.summary}</span>
          </p>
        </div>
      )}

      {/* 行4：SLA 倒计时进度条 */}
      <div className="mt-2.5"><SlaBar sla={ticket.sla} /></div>

      {/* 行5：业务标签 + 时间戳 */}
      <div className="mt-2 flex items-center gap-1.5">
        {ticket.tags.map((tg) => (
          <span key={tg} className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-xs leading-4 text-foreground-muted ring-1 ring-inset ring-border-default">{tg}</span>
        ))}
        <span className="ml-auto shrink-0 text-xs leading-4 text-foreground-disabled">{ticket.time}</span>
      </div>
    </button>
  );
}

function CountStat({ label, value, dot, tone }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-0.5 py-1">
      <span className={`text-base leading-5 [font-weight:var(--font-semibold)] ${tone}`}>{value}</span>
      <span className="inline-flex items-center gap-1 text-xs leading-4 text-foreground-muted">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />{label}
      </span>
    </div>
  );
}

function TriagePanel({ selectedId, onSelect, filters, onToggleFilter }) {
  const [collapsed, setCollapsed] = useState({});
  const toggleGroup = (g) => setCollapsed((prev) => ({ ...prev, [g]: !prev[g] }));

  const counts = useMemo(() => ({
    need: TICKETS.filter((t) => t.group === '需介入').length,
    hosting: TICKETS.filter((t) => t.group === '托管中').length,
    done: TICKETS.filter((t) => t.group === '已完成').length,
  }), []);

  const filtered = filters.length
    ? TICKETS.filter((t) => filters.every((key) => matchFilter(t, key)))
    : TICKETS;

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border-default bg-surface xl:w-80">
      <div className="shrink-0 px-4 pt-4">
        <FormTitle variant="level-2" title="托管工单" />

        {/* 1. 数量条（只读）：需介入 / 托管中 / 已完成 */}
        <div className="mt-3 flex items-center rounded-lg bg-blueGrey-100 px-2 py-1.5">
          <CountStat label="需介入" value={counts.need} dot="bg-red-500" tone="text-red-600" />
          <span className="h-7 w-px bg-border-default" />
          <CountStat label="托管中" value={counts.hosting} dot="bg-blue-500" tone="text-foreground" />
          <span className="h-7 w-px bg-border-default" />
          <CountStat label="已完成" value={counts.done} dot="bg-green-500" tone="text-foreground" />
        </div>

        {/* 2. 筛选 chips（多选） */}
        <div className="mt-3 flex flex-wrap gap-2 pb-3">
          {FILTER_DEFS.map((def) => {
            const isAll = def.key === 'all';
            const active = isAll ? filters.length === 0 : filters.includes(def.key);
            return (
              <button
                key={def.key}
                type="button"
                onClick={() => onToggleFilter(def.key)}
                className={[
                  'rounded-full border px-2.5 py-1 text-xs leading-4 transition-colors [font-weight:var(--font-medium)]',
                  active ? 'border-border-brand bg-brand-50 text-brand-700' : 'border-border-default bg-surface text-foreground-secondary hover:bg-blueGrey-50',
                ].join(' ')}
              >
                {def.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. 可折叠分组列表（需介入 / 托管中 / 已完成） */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {GROUP_ORDER.map((group) => {
          const items = filtered
            .filter((t) => t.group === group)
            .sort((a, b) => a.priority - b.priority);
          if (!items.length) return null;
          const meta = GROUP_META[group];
          const isCollapsed = collapsed[group];
          const isNeed = group === '需介入';
          return (
            <div key={group} className="mt-3 first:mt-0">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                className="flex w-full items-center gap-1.5 py-1.5 text-xs leading-4 [font-weight:var(--font-semibold)]"
              >
                <Icon name="chevron-down-stroked" size="xs" className={`shrink-0 text-foreground-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                <span className={meta.tone}>{group}</span>
                <span className="text-foreground-muted">{items.length}</span>
                {isNeed && <span className="ml-auto text-foreground-disabled [font-weight:var(--font-normal)]">按紧急度排序</span>}
              </button>
              {!isCollapsed && (
                <div className="mt-1 flex flex-col gap-2">
                  {items.map((t, i) => (
                    <TicketItem
                      key={t.id}
                      ticket={t}
                      rank={i}
                      isTop={isNeed && i === 0}
                      selected={t.id === selectedId}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* 对话气泡（AI 节点只展示关键结论，思考过程默认收起） */
function ChatRow({ msg, highlighted, registerRef }) {
  const [showThinking, setShowThinking] = useState(false);
  if (msg.role === 'user') {
    return (
      <div ref={registerRef} className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 text-xs leading-4 text-foreground-muted">
          <span>{msg.time}</span><span className="[font-weight:var(--font-medium)] text-foreground-secondary">{msg.name}</span>
        </div>
        <div className="max-w-[78%] rounded-lg rounded-tr-sm bg-chat-outgoing px-3 py-2 text-sm leading-5 text-foreground">{msg.text}</div>
      </div>
    );
  }
  return (
    <div ref={registerRef} className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-1.5 text-xs leading-4 text-foreground-muted">
        <span className="inline-flex items-center gap-1 [font-weight:var(--font-medium)] text-brand-700"><Icon name="cpu-chip-01-stroked" size="xs" />{msg.name}</span>
        <span>{msg.time}</span>
      </div>
      <div className={[
        'max-w-[82%] rounded-lg rounded-tl-sm px-3 py-2 text-sm leading-5 transition-colors',
        msg.exception ? 'border border-red-500 bg-red-50 text-foreground' : 'bg-chat-incoming text-foreground-secondary',
        highlighted ? 'ring-2 ring-brand-500' : '',
      ].join(' ')}>
        {msg.exception && (
          <div className="mb-1 inline-flex items-center gap-1 text-xs leading-4 [font-weight:var(--font-semibold)] text-red-600">
            <Icon name="alert-triangle-stroked" size="xs" />外呼异常
          </div>
        )}
        <div>{msg.text}</div>
        {msg.caption && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border-l-2 border-red-500 bg-surface px-2 py-1.5 text-xs leading-4 [font-weight:var(--font-medium)] text-red-600">
            <Icon name="alert-octagon-stroked" size="xs" className="mt-0.5 shrink-0" />
            <span>{msg.caption}</span>
          </div>
        )}
        {/* 思考过程：默认收起，仅展示关键结论；点击才展开 */}
        {msg.thinking && (
          <div className="mt-2 border-t border-border-default pt-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowThinking((v) => !v); }}
              className="inline-flex items-center gap-1 text-xs leading-4 text-foreground-muted transition-colors hover:text-foreground-secondary"
            >
              <Icon name="chevron-down-stroked" size="xs" className={`transition-transform ${showThinking ? '' : '-rotate-90'}`} />
              思考过程
            </button>
            {showThinking && (
              <p className="mt-1.5 rounded-md bg-surface px-2 py-1.5 text-xs leading-4 text-foreground-muted">{msg.thinking}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ②③ 决策卡：要你确认什么（卡点）→ 确认依据（为什么）→ 决策操作。
 * 把"决策级依据"贴在决策点旁边，坐席无需跳到右栏即可完成介入闭环。
 * 「修改」内联展开（卡内改参数），而非弹窗——减少模态跳转，"修改后执行"动作连续。 */
function DecisionCard({ resolved, amount, onAmountChange, onAdopt, onReject, onTrace }) {
  const [editing, setEditing] = useState(false);
  if (resolved) {
    return (
      <div className="self-start max-w-[88%] rounded-lg border border-green-500 bg-green-50 px-4 py-3">
        <div className="flex items-center gap-1.5 text-sm leading-5 [font-weight:var(--font-semibold)] text-green-600">
          <Icon name="check-circle-stroked" size="sm" />{resolved}
        </div>
      </div>
    );
  }
  const confVariant = CONF_VARIANT[DECISION.confidenceLevel];
  const confLabel = CONF_LABEL[DECISION.confidenceLevel];
  const numericAmount = Number(amount) || DECISION.baseAmount;
  return (
    <div className="self-start w-full max-w-[88%] overflow-hidden rounded-card border border-border-default bg-surface shadow-sm">
      {/* ② 要你确认什么（卡点）—— 红色顶条，一眼锁定介入点，决策问题用疑问句 */}
      <div className="border-b border-border-default bg-red-50 px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs leading-4 [font-weight:var(--font-semibold)] text-red-600">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-foreground-inverse">
            <Icon name="hand-stroked" size="xs" />
          </span>
          需你确认
        </div>
        <p className="mt-1.5 text-sm leading-5 [font-weight:var(--font-semibold)] text-foreground">{DECISION.question}</p>
      </div>

      <div className="p-4">
        {/* AI 建议 + 置信度（颜色随高/中/低自动映射） */}
        <div className="flex items-center gap-2">
          <Icon name="stars-02-stroked" size="sm" className="text-brand-700" />
          <span className="text-sm leading-5 [font-weight:var(--font-semibold)] text-foreground">AI 建议</span>
          <Tag variant={confVariant} size="s" className="ml-auto">置信度 {DECISION.confidence}%（{confLabel}）</Tag>
        </div>
        <div className="mt-2 rounded-md bg-brand-50 p-3">
          <div className="text-sm leading-5 [font-weight:var(--font-semibold)] text-foreground">{DECISION.recommendation}</div>
          <div className="mt-1 text-xs leading-4 text-foreground-muted">备选：{DECISION.alternative}</div>
        </div>

        {/* ③ 确认依据（为什么）—— 决策级依据，贴着决策点，可溯源到执行链节点 */}
        <div className="mt-3 rounded-md border border-border-default p-3">
          <div className="flex items-center gap-1.5 text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">
            <Icon name="file-search-02-stroked" size="xs" className="text-foreground-muted" />确认依据
            <span className="ml-auto text-foreground-disabled [font-weight:var(--font-normal)]">{DECISION_EVIDENCE.length} 条 · 点条目溯源</span>
          </div>
          <ol className="mt-2 flex flex-col gap-1">
            {DECISION_EVIDENCE.map((ev, i) => (
              <li key={i}>
                <button
                  type="button"
                  disabled={!ev.anchor}
                  onClick={() => ev.anchor && onTrace(ev.anchor)}
                  className={`flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left text-xs leading-4 transition-colors ${ev.anchor ? 'text-brand-700 hover:bg-brand-50' : 'cursor-default text-foreground-secondary'}`}
                >
                  <span className="shrink-0 [font-weight:var(--font-semibold)]">{['①', '②', '③', '④'][i]}</span>
                  <span className="min-w-0">{ev.text}{ev.anchor && <span className="text-foreground-disabled"> · 溯源</span>}</span>
                </button>
              </li>
            ))}
          </ol>
          {/* 风险标注：底部一行 chips —— "敢不敢执行"的最后一道判断 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border-default pt-2">
            {DECISION.riskFlags.map((r) => {
              const cls = r.tone === 'red'
                ? 'bg-red-50 text-red-600'
                : r.tone === 'orange'
                  ? 'bg-orange-50 text-orange-600'
                  : 'bg-green-50 text-green-600';
              return (
                <span key={r.label} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs leading-4 [font-weight:var(--font-medium)] ${cls}`}>
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${r.tone === 'red' ? 'bg-red-500' : r.tone === 'orange' ? 'bg-orange-500' : 'bg-green-500'}`} aria-hidden />
                  {r.label}
                </span>
              );
            })}
            <span className="ml-auto text-xs leading-4 text-foreground-muted">责任方：<span className="[font-weight:var(--font-medium)] text-foreground-secondary">{DECISION.responsibility}</span></span>
          </div>
        </div>

        {/* 决策操作 —— 强权重主操作（实心高对比，文案含动作+金额，不使用"确定/提交"） */}
        <button
          type="button"
          onClick={() => onAdopt(numericAmount)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-red-600 px-4 py-2.5 text-sm leading-5 [font-weight:var(--font-semibold)] text-foreground-inverse transition-colors hover:bg-red-500 active:scale-[0.99]"
        >
          <Icon name="shield-tick-stroked" size="sm" />
          采纳并执行 · 垫付 ¥{numericAmount} 并关单
        </button>
        {/* 次级操作：修改（内联）/ 驳回（反馈 AI 学习） */}
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="outline-black" className="flex-1" onClick={() => setEditing((v) => !v)}>
            {editing ? '收起修改' : '修改金额'}
          </Button>
          <Button size="sm" variant="text-black" className="flex-1" onClick={onReject}>驳回 · 反馈 AI</Button>
        </div>
        {/* 内联修改区：直接改卡内参数，无须跳模态；主按钮文案随之实时更新 */}
        {editing && (
          <div className="mt-2 rounded-md border border-border-default bg-blueGrey-100 p-3">
            <div className="flex items-center gap-2">
              <Icon name="edit-02-stroked" size="xs" className="shrink-0 text-foreground-muted" />
              <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">修改垫付金额</span>
              <span className="ml-auto text-xs leading-4 text-foreground-muted">原建议 ¥{DECISION.baseAmount}</span>
            </div>
            <div className="mt-2">
              <Input
                value={amount}
                onChange={(e) => onAmountChange(e.target.value)}
                prefix={<Icon name="currency-yen-stroked" size="sm" />}
              />
            </div>
            <div className="mt-1.5 text-xs leading-4 text-foreground-muted">
              {numericAmount > APPROVAL_LIMIT
                ? <span className="text-orange-600">超过 ¥{APPROVAL_LIMIT} 免审上限，执行时将自动转上级审批</span>
                : <>在 ¥{APPROVAL_LIMIT} 免审上限内，可由坐席直接垫付</>}
            </div>
          </div>
        )}
        <div className="mt-2 text-center text-xs leading-4 text-foreground-muted">执行前需二次确认 · 更多上下文见侧栏</div>
      </div>
    </div>
  );
}

function CenterChat({ selectedTicketId, resolved, highlightAnchor, onJump, onAdopt, onReject, onAmountChange, amount, ownership }) {
  const rowRefs = useRef({});
  const scrollRef = useRef(null);

  const jumpTo = (anchor) => {
    const el = rowRefs.current[anchor];
    if (el && scrollRef.current) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onJump(anchor);
    }
  };

  /* 选中工单 → 自动聚焦到对话流中第一条异常气泡（无异常则落到最后一条 AI 消息），
     让坐席一眼看到"卡在哪"，无需独立的执行节点带。 */
  useEffect(() => {
    const ex = CHAT.find((m) => m.exception) || CHAT[CHAT.length - 1];
    if (!ex) return;
    const id = setTimeout(() => jumpTo(ex.id), 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTicketId]);

  return (
    <main className="flex flex-1 min-w-0 flex-col overflow-hidden bg-blueGrey-200">
      {/* 工单头：标题 + 状态标签 + 接管态徽标 */}
      <div className="shrink-0 border-b border-border-default bg-surface px-5 py-3">
        <div className="flex items-center gap-2">
          <FormTitle variant="level-2" title="售后追单 · 商家拒接" />
          <Tag variant="red" size="m" className="ml-1">需介入</Tag>
          {ownership === 'human' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs leading-4 [font-weight:var(--font-medium)] text-orange-600">
              <Icon name="user-check-01-stroked" size="xs" />已接管 · 张三
            </span>
          )}
          <span className="ml-auto text-xs leading-4 text-foreground-muted">工单号 7644…854639</span>
        </div>
      </div>

      {/* 对话流（经过 · 明细）：自然时间顺序的介入叙事正文 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {CHAT.map((msg) => (
            <ChatRow
              key={msg.id}
              msg={msg}
              highlighted={highlightAnchor === msg.id}
              registerRef={(el) => { rowRefs.current[msg.id] = el; }}
            />
          ))}
          {/* ②③ 决策卡：卡点 → 依据 → 操作（修改内联） */}
          <DecisionCard
            resolved={resolved}
            amount={amount}
            onAmountChange={onAmountChange}
            onAdopt={onAdopt}
            onReject={onReject}
            onTrace={(anchor) => jumpTo(anchor)}
          />
        </div>
      </div>
    </main>
  );
}

/* ── 底栏 · 工具行 + 双模式 chat ──
 * 设计目标：在不切走当前工单上下文的前提下，承载两类输入：
 *   - 对 Agent 说（指令）：进入中栏对话流，有副作用的指令拦二次确认；
 *   - AI 搜（查询）：结果落在底栏上方浮层，不污染中栏时间线。
 * 工具行：接管前禁用（防止 agent 在跑时坐席并发出手）；接管后激活，并整体琥珀色高亮提示「球在你手上」。
 */
function ToolButton({ tool, disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? `${tool.label} · 需先接管工单` : tool.desc}
      className={[
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs leading-4 [font-weight:var(--font-medium)] transition-colors',
        disabled
          ? 'cursor-not-allowed border-border-default bg-blueGrey-100 text-foreground-disabled'
          : tool.effect === 'high'
            ? 'border-red-200 bg-surface text-foreground-secondary hover:border-red-500 hover:bg-red-50 hover:text-red-600'
            : 'border-border-default bg-surface text-foreground-secondary hover:border-border-brand hover:bg-brand-50 hover:text-brand-700',
      ].join(' ')}
    >
      <Icon name={tool.icon} size="xs" />{tool.label}
      {tool.effect === 'high' && !disabled && (
        <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
      )}
    </button>
  );
}

function BottomBar({ ownership, onToggleOwnership, onToolUse, onSendCmd, onSearch, lastSearch, onCloseSearch }) {
  const [mode, setMode] = useState('cmd');           // 'cmd' | 'search'
  const [input, setInput] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const toolDisabled = ownership !== 'human';
  const currentMode = CHAT_MODES.find((m) => m.key === mode);
  const quickActions = QUICK_ACTIONS_BY_MODE[mode];

  const send = () => {
    const v = input.trim();
    if (!v) return;
    if (mode === 'cmd') onSendCmd(v);
    else onSearch(v);
    setInput('');
  };

  return (
    <footer
      className={[
        'shrink-0 border-t bg-surface',
        ownership === 'human' ? 'border-orange-200 bg-orange-50/40' : 'border-border-default',
      ].join(' ')}
    >
      {/* AI 搜结果浮层：临时面板，不污染中栏；可关闭 */}
      {lastSearch && mode === 'search' && (
        <div className="border-b border-border-default bg-blueGrey-100 px-5 py-3">
          <div className="mx-auto max-w-3xl">
            <div className="mb-2 flex items-center gap-1.5">
              <Icon name="search-md-stroked" size="xs" className="text-brand-700" />
              <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">AI 搜 · 查询「{lastSearch.query}」</span>
              <button
                type="button"
                onClick={onCloseSearch}
                className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-foreground-muted hover:bg-blueGrey-200 hover:text-foreground"
                aria-label="关闭检索结果"
              >
                <Icon name="x-close-stroked" size="xs" />
              </button>
            </div>
            <ul className="flex flex-col gap-2">
              {lastSearch.results.map((r, i) => (
                <li key={i} className="rounded-md bg-surface px-3 py-2">
                  <div className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground">{r.title}</div>
                  <div className="mt-1 text-xs leading-4 text-foreground-secondary">{r.body}</div>
                  <div className="mt-1 inline-flex items-center gap-1 text-xs leading-4 text-foreground-disabled">
                    <Icon name="file-02-stroked" size="xs" />来源：{r.source}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-xs leading-4 text-foreground-muted">检索结果仅本次会话可见，不写入工单时间线</div>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-3xl px-5 py-3">
        {/* 第 1 行：接管控制 + 主工具栏 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleOwnership}
            className={[
              'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs leading-4 [font-weight:var(--font-semibold)] transition-colors',
              ownership === 'human'
                ? 'bg-orange-50 text-orange-600 ring-1 ring-orange-500 hover:bg-orange-100'
                : 'bg-brand-50 text-brand-700 ring-1 ring-border-brand hover:bg-brand-100',
            ].join(' ')}
            title={ownership === 'human' ? '将工单交回 AI 托管' : '由我接管，停下 AI 自动动作'}
          >
            <Icon name={ownership === 'human' ? 'repeat-04-stroked' : 'hand-stroked'} size="xs" />
            {ownership === 'human' ? '交回 AI 托管' : '我来接管'}
          </button>
          <span className="shrink-0 text-xs leading-4 text-foreground-muted">
            {ownership === 'human' ? '处理人：张三（你）' : '处理人：AI（Ticko）'}
          </span>

          {/* 工具行：横向滚动，接管前禁用 */}
          <div className="ml-auto flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pl-2">
            {PRIMARY_TOOLS.map((t) => (
              <ToolButton key={t.key} tool={t} disabled={toolDisabled} onClick={() => onToolUse(t)} />
            ))}
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              disabled={toolDisabled}
              className={[
                'inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs leading-4 [font-weight:var(--font-medium)] transition-colors',
                toolDisabled
                  ? 'cursor-not-allowed border-border-default bg-blueGrey-100 text-foreground-disabled'
                  : moreOpen
                    ? 'border-border-brand bg-brand-50 text-brand-700'
                    : 'border-border-default bg-surface text-foreground-secondary hover:bg-blueGrey-50',
              ].join(' ')}
            >
              <Icon name="menu-01-stroked" size="xs" />更多工具
              <Icon name="chevron-down-stroked" size="xs" className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {/* 更多工具抽屉 */}
        {moreOpen && !toolDisabled && (
          <div className="mt-2 rounded-md border border-border-default bg-blueGrey-100 p-2">
            <div className="flex flex-wrap gap-1.5">
              {MORE_TOOLS.map((t) => (
                <ToolButton key={t.key} tool={t} disabled={false} onClick={() => { onToolUse(t); setMoreOpen(false); }} />
              ))}
            </div>
            <div className="mt-2 text-xs leading-4 text-foreground-muted">辅助工具 · 按使用频次可置顶到主工具栏</div>
          </div>
        )}

        {/* 第 2 行：chat 模式开关 + 快捷 chips */}
        <div className="mt-3 flex items-center gap-2">
          <div className="inline-flex shrink-0 items-center rounded-full border border-border-default bg-surface p-0.5">
            {CHAT_MODES.map((m) => {
              const active = mode === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMode(m.key)}
                  className={[
                    'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs leading-4 transition-colors [font-weight:var(--font-medium)]',
                    active
                      ? m.key === 'cmd' ? 'bg-brand-50 text-brand-700' : 'bg-fill text-foreground'
                      : 'text-foreground-secondary hover:text-foreground',
                  ].join(' ')}
                  title={m.key === 'cmd' ? '指令会进入中栏对话流并可能触发动作' : '查询不进入对话流、不触发动作'}
                >
                  <Icon name={m.icon} size="xs" />{m.label}
                </button>
              );
            })}
          </div>
          <div className="ml-1 flex min-w-0 flex-1 flex-wrap gap-1.5">
            {quickActions.map((qa) => (
              <button
                key={qa.label}
                type="button"
                onClick={() => setInput(qa.fill)}
                className="inline-flex items-center gap-1 rounded-full border border-border-default bg-surface px-2 py-0.5 text-xs leading-4 text-foreground-secondary transition-colors hover:border-border-brand hover:bg-brand-50 hover:text-brand-700"
              >
                <Icon name="corner-up-right-stroked" size="xs" />{qa.label}
              </button>
            ))}
          </div>
        </div>

        {/* 第 3 行：输入框 + 发送 */}
        <div className="mt-2 flex items-end gap-2">
          <div className="flex-1">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={currentMode.placeholder}
              prefix={<Icon name={mode === 'cmd' ? 'message-chat-square-stroked' : 'search-md-stroked'} size="sm" />}
              allowClear
              onClear={() => setInput('')}
            />
          </div>
          <Button
            variant={mode === 'cmd' ? 'primary' : 'outline-black'}
            icon={<Icon name={mode === 'cmd' ? 'send-01-stroked' : 'search-md-stroked'} size="sm" />}
            onClick={send}
          >
            {mode === 'cmd' ? '发送指令' : '检索'}
          </Button>
        </div>

        <div className="mt-1 text-xs leading-4 text-foreground-muted">
          {mode === 'cmd'
            ? '指令会进入中栏对话流；外呼/退款/通信等真实动作执行前需二次确认'
            : '查询结果只在本次会话可见，不写入工单时间线 · 来源可点击溯源'}
        </div>
      </div>
    </footer>
  );
}

/* ── 右栏 · 辅助信息（Trae 式工具面板：常驻图标栏 + 点击展开抽屉，非常驻） ──
 * 三类辅助信息，点击图标才展开，再点同图标收起，点别的图标切换：
 *   summary  摘要      ：工单维度（问题/诉求/方案）+ 任务维度（agent 进展精简摘要，不复刻中栏执行链）
 *   log      工单日志  ：全生命周期时间轴
 *   user     用户上下文：进线前 IM + 该用户的相似工单
 * 决策级依据已并入中栏；此处只放「想深挖才看」的深度上下文。*/
const COPILOT_PANES = [
  { key: 'summary', label: '摘要', icon: 'clipboard-check-stroked', desc: '工单与任务总结' },
  { key: 'log', label: '工单日志', icon: 'clock-stroked', desc: '处理时间轴' },
  { key: 'user', label: '用户上下文', icon: 'user-01-stroked', desc: '进线前 IM 与相似工单' },
];

function SummaryPane() {
  return (
    <div className="flex flex-col gap-5">
      {/* 工单维度 */}
      <section>
        <div className="flex items-center gap-1.5">
          <Icon name="file-search-02-stroked" size="xs" className="text-foreground-muted" />
          <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">工单维度</span>
        </div>
        <dl className="mt-3 flex flex-col gap-2.5">
          {TICKET_SUMMARY.map((r) => (
            <div key={r.label}>
              <dt className="text-xs leading-4 [font-weight:var(--font-medium)] text-foreground-muted">{r.label}</dt>
              <dd className="mt-0.5 text-xs leading-5 text-foreground-secondary">{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {/* 任务维度（精简摘要，明示链路明细在中栏） */}
      <section className="border-t border-border-default pt-5">
        <div className="flex items-center gap-1.5">
          <Icon name="cpu-chip-01-stroked" size="xs" className="text-brand-700" />
          <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">任务维度 · Agent 进展</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs leading-4">
          <span className="text-foreground-muted">当前阶段：<span className="[font-weight:var(--font-medium)] text-foreground-secondary">{TASK_SUMMARY.stage}</span></span>
          <span className="text-foreground-muted">进度：<span className="[font-weight:var(--font-medium)] text-foreground-secondary">{TASK_SUMMARY.progress}</span></span>
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 [font-weight:var(--font-medium)] text-red-600">{TASK_SUMMARY.state}</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-foreground-muted">{TASK_SUMMARY.note}</p>
        <p className="mt-2 text-xs leading-4 text-foreground-disabled">完整处理经过与决策依据见中栏对话流</p>
      </section>
    </div>
  );
}

function LogPane() {
  return (
    <section>
      <div className="flex items-center gap-1.5">
        <Icon name="clock-stroked" size="xs" className="text-foreground-muted" />
        <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">工单日志 · 时间轴</span>
      </div>
      <ol className="mt-3 flex flex-col">
        {TICKET_LOG.map((l, i) => (
          <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
            {i < TICKET_LOG.length - 1 && <span className="absolute left-[3px] top-2 h-full w-px bg-border-default" aria-hidden />}
            <span className="mt-1 inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-brand-500" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs leading-4">
                <span className="[font-weight:var(--font-semibold)] text-foreground-secondary">{l.time}</span>
                <span className="rounded bg-fill px-1.5 py-0.5 text-foreground-muted">{l.actor}</span>
              </div>
              <p className="mt-0.5 text-xs leading-5 text-foreground-secondary">{l.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function UserPane() {
  return (
    <div className="flex flex-col gap-5">
      {/* 进线前 IM */}
      <section>
        <div className="flex items-center gap-1.5">
          <Icon name="message-chat-square-stroked" size="xs" className="text-foreground-muted" />
          <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">进线前 IM 记录</span>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {USER_IM_LOG.map((m, i) => (
            <li key={i} className="rounded-md bg-fill px-3 py-2 text-xs leading-4">
              <span className="text-foreground-muted">{m.time}</span>
              <p className="mt-0.5 text-foreground-secondary">{m.text}</p>
            </li>
          ))}
        </ul>
      </section>
      {/* 相似工单 */}
      <section className="border-t border-border-default pt-5">
        <div className="flex items-center gap-1.5">
          <Icon name="file-02-stroked" size="xs" className="text-foreground-muted" />
          <span className="text-xs leading-4 [font-weight:var(--font-semibold)] text-foreground-secondary">该用户的相似工单</span>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {USER_SIMILAR_TICKETS.map((t) => (
            <li key={t.code} className="rounded-md bg-fill px-3 py-2 transition-colors hover:bg-fill-hover">
              <div className="flex items-center gap-2 text-xs leading-4">
                <span className="[font-weight:var(--font-medium)] text-foreground-secondary">{t.scene}</span>
                <span className="ml-auto text-foreground-disabled">{t.time}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs leading-4 text-foreground-muted">
                <Icon name="hash-01-stroked" size="xs" className="shrink-0" />
                <span className="truncate">{t.code}</span>
              </div>
              <div className="mt-1 text-xs leading-4 text-green-600">{t.result}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CopilotPanel({ activePane, onTogglePane }) {
  const active = COPILOT_PANES.find((p) => p.key === activePane) || null;
  return (
    <div className="flex shrink-0">
      {/* 抽屉：仅当有激活面板时展开 */}
      {active && (
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-border-default bg-surface xl:w-96">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border-default px-4 py-2.5">
            <Icon name={active.icon} size="sm" className="text-brand-700" />
            <span className="text-sm leading-5 [font-weight:var(--font-semibold)] text-foreground">{active.label}</span>
            <span className="text-xs leading-4 text-foreground-muted">{active.desc}</span>
            <button
              type="button"
              onClick={() => onTogglePane(active.key)}
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-blueGrey-100 hover:text-foreground-secondary"
              title="收起"
            >
              <Icon name="chevron-right-double-stroked" size="sm" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {active.key === 'summary' && <SummaryPane />}
            {active.key === 'log' && <LogPane />}
            {active.key === 'user' && <UserPane />}
          </div>
        </aside>
      )}

      {/* 常驻图标栏 */}
      <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-border-default bg-surface py-3">
        {COPILOT_PANES.map((p) => {
          const on = p.key === activePane;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onTogglePane(p.key)}
              title={`${p.label} · ${p.desc}`}
              className={[
                'inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                on ? 'bg-brand-50 text-brand-700' : 'text-foreground-muted hover:bg-blueGrey-100 hover:text-foreground-secondary',
              ].join(' ')}
            >
              <Icon name={p.icon} size="md" />
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ② 高风险确认弹窗（金额 ≤ 上限 → 执行；超限 → 转上级审批） */
function HighRiskModal({ amount, onCancel, onConfirm }) {
  const numeric = Number(amount) || 0;
  const overLimit = numeric > APPROVAL_LIMIT;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
      <Modal
        layout="center"
        size="sm"
        title={overLimit ? '金额超限 · 需上级审批' : '高风险操作确认'}
        subtitle={null}
        cancelText="取消"
        confirmText={overLimit ? '提交上级审批' : `确认垫付 ¥${numeric} 并关单`}
        onCancel={onCancel}
        onConfirm={() => onConfirm(overLimit)}
        showFooterHint
        footerHint={overLimit ? `金额 ¥${numeric} 超过 ¥${APPROVAL_LIMIT} 免审上限` : '此操作不可撤销，请核对后执行'}
      >
        <div className="flex flex-col gap-3">
          <div className={`flex items-start gap-2 rounded-md px-3 py-2.5 ${overLimit ? 'bg-orange-50' : 'bg-red-50'}`}>
            <Icon name={overLimit ? 'alert-circle-stroked' : 'alert-octagon-stroked'} size="sm" className={`mt-0.5 shrink-0 ${overLimit ? 'text-orange-600' : 'text-red-600'}`} />
            <div className={`text-sm leading-5 [font-weight:var(--font-medium)] ${overLimit ? 'text-orange-600' : 'text-red-600'}`}>
              {overLimit
                ? `垫付金额 ¥${numeric} 超过免审上限，将提交上级坐席审批，审批通过后自动执行。`
                : `即将垫付退款 ¥${numeric} 并关单，资金动作不可撤销。`}
            </div>
          </div>
          <dl className="flex flex-col gap-2 rounded-md bg-blueGrey-100 px-3 py-2.5">
            {[
              ['操作', '垫付退款并关单'],
              ['金额', `¥${numeric}`],
              ['责任方', DECISION.responsibility],
              ['资金回收', DECISION.recoverable],
              ['免审上限', `¥${APPROVAL_LIMIT}`],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 text-xs leading-4">
                <dt className="shrink-0 text-foreground-muted">{k}</dt>
                <dd className="min-w-0 text-right [font-weight:var(--font-medium)] text-foreground-secondary">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Modal>
    </div>
  );
}

/* ── 根组件 ── */
export default function App() {
  const [selectedTicketId, setSelectedTicketId] = useState('t1');
  const [filters, setFilters] = useState([]);
  const [highlightAnchor, setHighlightAnchor] = useState(null);
  const [resolved, setResolved] = useState(null);
  const [riskOpen, setRiskOpen] = useState(false);
  const [amount, setAmount] = useState(String(DECISION.baseAmount));
  const [toast, setToast] = useState(null);

  /* 右栏 · Trae 式工具面板：默认展开「摘要」；点同 icon 收起、点别的切换 */
  const [activePane, setActivePane] = useState('summary');
  const togglePane = (key) => setActivePane((prev) => (prev === key ? null : key));

  /* 底栏 · 接管态机：ai = AI 托管中（默认）/ human = 坐席手动处理。可双向切换。 */
  const [ownership, setOwnership] = useState('ai');
  /* 高副作用指令的确认弹窗 */
  const [pendingCmd, setPendingCmd] = useState(null);   // { text } 或 null
  /* 工具行的确认弹窗（接管后高副作用工具点击也要拦） */
  const [pendingTool, setPendingTool] = useState(null); // { tool } 或 null
  /* AI 搜结果浮层 */
  const [lastSearch, setLastSearch] = useState(null);   // { query, results }

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!highlightAnchor) return undefined;
    const id = setTimeout(() => setHighlightAnchor(null), 1400);
    return () => clearTimeout(id);
  }, [highlightAnchor]);

  /* 采纳：现在 amount 由决策卡内联控制，App 仅打开二次确认弹窗 */
  const openRisk = () => setRiskOpen(true);

  const confirmRisk = (overLimit) => {
    setRiskOpen(false);
    if (overLimit) {
      setResolved(`已提交上级审批 · 垫付 ¥${Number(amount)} 并关单`);
      setToast({ type: 'info', message: '已提交上级审批，等待审批结果' });
    } else {
      setResolved(`已执行 · 垫付 ¥${Number(amount)} 并关单`);
      setToast({ type: 'success', message: `已垫付 ¥${Number(amount)} 并关单` });
    }
  };

  const reject = () => {
    setResolved('已驳回该方案 · 已反馈 AI 学习');
    setToast({ type: 'info', message: '已驳回并反馈 AI 学习' });
  };

  /* 接管切换：人接管 → 暂停 agent，工具行激活；交回 AI → agent 接手 */
  const toggleOwnership = () => {
    const next = ownership === 'ai' ? 'human' : 'ai';
    setOwnership(next);
    setToast({
      type: next === 'human' ? 'success' : 'info',
      message: next === 'human' ? '已接管 · 工具行已激活，AI 暂停自动动作' : '已交回 AI 托管，自动流程继续',
    });
  };

  /* 工具点击：副作用高 → 二次确认；低/无 → 直接执行（仅 Toast 示意）。 */
  const handleToolUse = (tool) => {
    if (tool.effect === 'high') {
      setPendingTool({ tool });
      return;
    }
    setToast({ type: 'success', message: `已执行 · ${tool.label}` });
  };
  const confirmToolUse = () => {
    if (!pendingTool) return;
    const { tool } = pendingTool;
    setPendingTool(null);
    setToast({ type: 'success', message: `已执行 · ${tool.label}` });
  };

  /* 指令发送：纯流程调整直接发；副作用高的指令拦二次确认 */
  const handleSendCmd = (text) => {
    if (isHighEffectCmd(text)) {
      setPendingCmd({ text });
      return;
    }
    setToast({ type: 'info', message: `已发送给 AI：${text.length > 18 ? text.slice(0, 18) + '…' : text}` });
  };
  const confirmCmd = () => {
    if (!pendingCmd) return;
    const { text } = pendingCmd;
    setPendingCmd(null);
    setToast({ type: 'success', message: `指令已下达：${text.length > 18 ? text.slice(0, 18) + '…' : text}` });
  };

  /* AI 搜：结果落底栏浮层，不进对话流 */
  const handleSearch = (query) => {
    setLastSearch({ query, results: matchSearch(query) });
    setToast({ type: 'info', message: `检索完成 · 共 ${matchSearch(query).length} 条结果` });
  };

  return (
    <div className="relative flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-blueGrey-200 text-sm text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <TriagePanel
          selectedId={selectedTicketId}
          onSelect={setSelectedTicketId}
          filters={filters}
          onToggleFilter={(key) => {
            if (key === 'all') { setFilters([]); return; }
            setFilters((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]);
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <CenterChat
            selectedTicketId={selectedTicketId}
            resolved={resolved}
            highlightAnchor={highlightAnchor}
            onJump={setHighlightAnchor}
            onAdopt={openRisk}
            onReject={reject}
            amount={amount}
            onAmountChange={setAmount}
            ownership={ownership}
          />
          <BottomBar
            ownership={ownership}
            onToggleOwnership={toggleOwnership}
            onToolUse={handleToolUse}
            onSendCmd={handleSendCmd}
            onSearch={handleSearch}
            lastSearch={lastSearch}
            onCloseSearch={() => setLastSearch(null)}
          />
        </div>
        <CopilotPanel activePane={activePane} onTogglePane={togglePane} />
      </div>

      {riskOpen && <HighRiskModal amount={amount} onCancel={() => setRiskOpen(false)} onConfirm={confirmRisk} />}

      {/* 工具行高副作用确认 */}
      {pendingTool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
          <Modal
            layout="center"
            size="sm"
            title={`确认执行：${pendingTool.tool.label}`}
            subtitle={null}
            cancelText="取消"
            confirmText={`确认 · ${pendingTool.tool.label}`}
            onCancel={() => setPendingTool(null)}
            onConfirm={confirmToolUse}
            showFooterHint
            footerHint="此动作有外部副作用，执行后不可撤销"
          >
            <div className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2.5">
              <Icon name="alert-octagon-stroked" size="sm" className="mt-0.5 shrink-0 text-red-600" />
              <div className="text-sm leading-5 [font-weight:var(--font-medium)] text-red-600">
                即将执行：{pendingTool.tool.label} · {pendingTool.tool.desc}
              </div>
            </div>
          </Modal>
        </div>
      )}

      {/* 指令副作用确认 */}
      {pendingCmd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
          <Modal
            layout="center"
            size="sm"
            title="确认下达指令"
            subtitle={null}
            cancelText="取消"
            confirmText="确认下达"
            onCancel={() => setPendingCmd(null)}
            onConfirm={confirmCmd}
            showFooterHint
            footerHint="该指令会让 AI 触发真实动作（外呼/通信/退款等），执行后不可撤销"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2.5">
                <Icon name="alert-octagon-stroked" size="sm" className="mt-0.5 shrink-0 text-red-600" />
                <div className="text-sm leading-5 [font-weight:var(--font-medium)] text-red-600">该指令包含副作用关键词，已识别为高风险</div>
              </div>
              <div className="rounded-md bg-blueGrey-100 px-3 py-2.5 text-sm leading-5 text-foreground">
                <span className="text-foreground-muted">指令内容：</span>{pendingCmd.text}
              </div>
            </div>
          </Modal>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[60] -translate-x-1/2">
          <Toast type={toast.type} message={toast.message} />
        </div>
      )}
    </div>
  );
}
