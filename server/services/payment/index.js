// P9-C 支付抽象（C-4）。
// 本期只完整实现 manual（线下人工收款：建 pending 单，管理员 mark-paid 才 paid）；
// stripe / cash 等在线渠道为占位实现，三个方法一律抛 payment_not_configured(501)。
// 任何自动化流程（Cron、重试、回调）都不得把订单置为 paid。
import { paymentNotConfigured } from '../../lib/errors.js';

const MANUAL_PAY_INSTRUCTIONS = '线下人工收款：请向站点管理员付款后，由管理员在后台标记已支付。';

/** manual provider：建单即 pending，不接在线回调。 */
const manual = {
  id: 'manual',
  implemented: true,
  async createOrder({ order }) {
    return {
      orderNo: order.orderNo,
      status: 'pending',
      payInstructions: MANUAL_PAY_INSTRUCTIONS,
      providerRef: null,
    };
  },
  verifyCallback() {
    // manual 无在线回调；回调入口留空，收到即视为未配置
    throw paymentNotConfigured('manual', { reason: 'manual 渠道无在线回调，需管理员人工标记' });
  },
  refund() {
    // 退款由管理员在后台触发，订单服务直接处理；不经过渠道退款接口
    throw paymentNotConfigured('manual', { reason: 'manual 渠道退款由管理员人工处理' });
  },
};

function placeholder(id) {
  const notConfigured = () => { throw paymentNotConfigured(id); };
  return {
    id,
    implemented: false,
    createOrder: notConfigured,
    verifyCallback: notConfigured,
    refund: notConfigured,
  };
}

/**
 * 取支付渠道实现。未知 / 未配置的 provider 返回占位对象，
 * 三个方法调用时一律抛 payment_not_configured(501)。
 */
export function getProvider(id) {
  const name = String(id || 'manual');
  if (name === 'manual') return manual;
  return placeholder(name);
}

export const PaymentProvider = manual;
