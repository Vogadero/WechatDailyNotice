/**
 * 对敏感字符串做日志脱敏，保留首尾少量字符用于排查配置是否串错。
 *
 * @param {string} value 待脱敏字符串
 * @param {number} visiblePrefix 保留的前缀长度
 * @param {number} visibleSuffix 保留的后缀长度
 * @returns {string} 脱敏后的字符串
 */
function maskSensitiveValue(value, visiblePrefix = 4, visibleSuffix = 4) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= visiblePrefix + visibleSuffix) return `${value.slice(0, visiblePrefix)}***`;
  return `${value.slice(0, visiblePrefix)}...${value.slice(-visibleSuffix)}`;
}

module.exports = {
  maskSensitiveValue
};
