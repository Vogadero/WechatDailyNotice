#!/usr/bin/env python3
"""
企业微信消息发送脚本
通过GitHub Actions Secrets或环境变量获取配置。
"""

import os
import sys
from wechatpush import WechatPush

def send_wechat_message(content, corp_id=None, secret=None, agent_id=None):
    """
    发送企业微信消息。

    Args:
        content (str): 要发送的文本内容，支持换行和超链接。
        corp_id (str): 企业ID。优先级：参数 > 环境变量 `WECOM_CORPID`。
        secret (str): 应用Secret。优先级：参数 > 环境变量 `WECOM_SECRET`。
        agent_id (str/int): 应用AgentId。优先级：参数 > 环境变量 `WECOM_AGENTID`。

    Returns:
        dict: 企业微信API的返回结果。
    """
    # 1. 获取配置（优先使用函数参数，其次使用环境变量）
    corp_id = corp_id or os.getenv('WECOM_CORPID')
    secret = secret or os.getenv('WECOM_SECRET')
    agent_id = agent_id or os.getenv('WECOM_AGENTID')

    # 2. 检查配置是否存在
    if not all([corp_id, secret, agent_id]):
        error_msg = "错误：缺少必要的配置！请提供 corp_id, secret, agent_id 参数或设置对应的环境变量 (WECOM_CORPID, WECOM_SECRET, WECOM_AGENTID)。"
        print(error_msg, file=sys.stderr)
        sys.exit(1)

    # 3. 初始化推送器并发送消息
    try:
        pusher = WechatPush(corp_id=corp_id, secret=secret, agent_id=int(agent_id))
        result = pusher.send_text(content)
        
        # 4. 检查发送结果
        if result.get('errcode') == 0:
            print(f"消息发送成功！MsgId: {result.get('msgid')}")
        else:
            print(f"消息发送失败！错误码: {result.get('errcode')}, 错误信息: {result.get('errmsg')}", file=sys.stderr)
        return result
        
    except Exception as e:
        print(f"发送过程中出现异常: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    # 这里是默认要发送的消息内容。
    # 你可以直接修改这里的字符串，或者通过命令行参数传入。
    default_message = """【每日提醒】⏰
你好！这是来自GitHub Actions的定时消息。
现在时间是（UTC+8）下午5点。
祝你有个愉快的傍晚！"""
    
    # 如果运行脚本时提供了命令行参数，则使用参数作为消息内容。
    # 例如：python send_wechat_msg.py "今天是个好日子"
    if len(sys.argv) > 1:
        message = ' '.join(sys.argv[1:])
    else:
        message = default_message
    
    send_wechat_message(message)