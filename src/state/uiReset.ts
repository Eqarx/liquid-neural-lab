/**
 * 全局「复位」信号。
 *
 * 语义：等同刷新页面 —— 浮窗位置与开关、折叠状态、镜头、设置值、舞台物体全部回到初始，
 * 但**保留你手写的内容**（清掉手写是「🧹 清空」的职责）与已看过的引导。
 */

export const PANEL_POS_KEY = 'digitlab-v2-panel-pos';
export const PANELS_KEY = 'digitlab-v2-panels';
export const SETTINGS_KEY = 'digitlab-v3-settings';

export interface PanelFlags {
  hint: boolean;
  result: boolean;
  legend: boolean;
  settings: boolean;
  model: boolean;
}

/** 刚打开页面时的浮窗开关 */
export const DEFAULT_PANELS: PanelFlags = { hint: true, result: true, legend: false, settings: false, model: false };

type Listener = () => void;
const listeners = new Set<Listener>();

/** 订阅复位（返回取消订阅函数） */
export function onUiReset(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 清掉持久化的界面状态并通知所有订阅者 */
export function emitUiReset(): void {
  try {
    localStorage.removeItem(PANEL_POS_KEY);
    localStorage.removeItem(PANELS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
  for (const fn of [...listeners]) fn();
}
