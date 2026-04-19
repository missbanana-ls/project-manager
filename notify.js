const fetch = require('node-fetch');

/**
 * 发送企业微信机器人通知
 * @param {string} webhookUrl - 企业微信机器人 Webhook 地址
 * @param {object} message - 消息体
 */
async function sendWechatNotification(webhookUrl, message) {
  if (!webhookUrl) {
    throw new Error('Webhook URL 未配置');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  const result = await response.json();

  if (result.errcode !== 0) {
    throw new Error(`企业微信通知发送失败: ${result.errmsg}`);
  }

  return result;
}

module.exports = { sendWechatNotification };
