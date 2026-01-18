#!/bin/bash

# 每日消息推送脚本

# 设置时区
export TZ="Asia/Shanghai"

# 获取当前时间
CURRENT_TIME=$(date '+%Y年%m月%d日 %H:%M:%S')
echo "当前时间: $CURRENT_TIME"

# 1. 获取最新的UID
echo "正在获取最新的UID..."
RESPONSE=$(curl -s "https://eob7gu4tu9r7a8s.m.pipedream.net")

if ! echo "$RESPONSE" | jq -e '.code == 200' > /dev/null 2>&1; then
    echo "第一个API调用失败"
    echo "响应内容: $RESPONSE"
    exit 1
fi

LATEST_UID=$(echo "$RESPONSE" | jq -r '.data[0].uid')
echo "获取到的UID: $LATEST_UID"

# 2. 获取一言内容
echo "正在获取一言内容..."
HITOKOTO_RESPONSE=$(curl -s "https://v1.hitokoto.cn/")

if ! echo "$HITOKOTO_RESPONSE" | jq -e '.hitokoto' > /dev/null 2>&1; then
    echo "第二个API调用失败"
    echo "响应内容: $HITOKOTO_RESPONSE"
    exit 1
fi

HITOKOTO=$(echo "$HITOKOTO_RESPONSE" | jq -r '.hitokoto')
FROM=$(echo "$HITOKOTO_RESPONSE" | jq -r '.from // "未知"')
echo "获取到的一言: $HITOKOTO"
echo "来源: $FROM"

# 3. 构造HTML内容
HTML_CONTENT="<h1>$HITOKOTO</h1><br/>"
HTML_CONTENT+="<p style='color: #666; font-size: 14px;'>—— $FROM</p><br/>"
HTML_CONTENT+="<p style='color: #999; font-size: 12px;'>每日一言推送</p>"

# 4. 构建发送消息的JSON数据
MESSAGE_DATA=$(cat <<EOF
{
  "appToken": "AT_C67vMtfIWhyGMKbm2jTTpkTY4OcaXHUP",
  "content": "$HTML_CONTENT",
  "summary": "$CURRENT_TIME",
  "contentType": 2,
  "uids": ["$LATEST_UID"],
  "topicIds": [],
  "verifyPayType": 0
}
EOF
)

echo "准备发送的消息数据:"
echo "$MESSAGE_DATA" | jq .

# 5. 发送消息
echo "正在发送消息..."
SEND_RESPONSE=$(curl -s -X POST "https://wxpusher.zjiecode.com/api/send/message" \
  -H "Content-Type: application/json" \
  -d "$MESSAGE_DATA")

echo "发送结果:"
echo "$SEND_RESPONSE" | jq .

if echo "$SEND_RESPONSE" | jq -e '.code == 1000' > /dev/null 2>&1; then
    echo "✅ 消息发送成功！"
    exit 0
else
    echo "❌ 消息发送失败"
    exit 1
fi