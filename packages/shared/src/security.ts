/**
 * 密保问题与账号安全相关常量、归一化函数（单一真源）。
 *
 * 预设问题存放在此，前后端共用同一份文案：前端下拉选项、服务端校验与
 * 忘记密码页回显都读这里，避免两处各写一份导致文案漂移。
 *
 * 用户也可自定义问题——落库时统一存**问题文本**而非 key：
 * 预设问题存其固定文案，自定义问题存用户输入原文。这样忘记密码页可直接
 * 回显，无需在前端维护 key↔文案映射，也不会因预设列表增删导致老数据失配。
 */

/** 预设密保问题（按展示顺序）。 */
export const PRESET_SECURITY_QUESTIONS: readonly string[] = [
  '你小学的名称是？',
  '你第一份工作的公司名称是？',
  '你养的宠物叫什么名字？',
  '你最喜欢的城市是？',
];

/** 密保问题文本上限（预设与自定义共用）。 */
export const SECURITY_QUESTION_MAX_LENGTH = 120;

/** 密保答案上限（仅约束长度，不臆造复杂度策略）。 */
export const SECURITY_ANSWER_MAX_LENGTH = 256;

/** 店铺名称上限。 */
export const SHOP_NAME_MAX_LENGTH = 100;

/**
 * 密保答案归一化：去首尾空白 + 转小写。
 *
 * 存与校验必须调用同一个函数，否则大小写/空格差异会造成“明明答对却重置失败”。
 * 保留内部空格（中文答案里空格有意义，过度折叠反而误伤）。
 */
export function normalizeSecurityAnswer(value: string): string {
  return value.trim().toLowerCase();
}
