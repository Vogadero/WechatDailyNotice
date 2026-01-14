#!/usr/bin/env python3
"""
企业微信消息发送脚本 - 自动处理可信IP问题
"""

import os
import sys
import requests
from wechatpush import WechatPush

def get_public_ip():
    """获取当前运行环境的公网IP地址"""
    try:
        # 使用一个可靠的公共服务获取IP
        response = requests.get('https://api.ipify.org?format=json', timeout=5)
        return response.json().get('ip')
    except Exception as e:
        print(f"获取公网IP失败: {e}")
        return None

def add_trusted_ip(corp_id, secret, agent_id, ip):
    """调用企业微信API，将指定IP添加到应用的可信IP列表"""
    # 1. 获取access_token
    token_url = f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={corp_id}&corpsecret={secret}"
    token_resp = requests.get(token_url).json()
    
    if token_resp.get('errcode') != 0:
        print(f"获取access_token失败: {token_resp}")
        return False
    
    access_token = token_resp.get('access_token')
    
    # 2. 获取应用当前的可信IP列表
    get_url = f"https://qyapi.weixin.qq.com/cgi-bin/agent/get?access_token={access_token}&agentid={agent_id}"
    app_info = requests.get(get_url).json()
    
    if app_info.get('errcode') != 0:
        print(f"获取应用信息失败: {app_info}")
        return False
    
    # 3. 更新可信IP列表（追加新IP）
    allow_ips = app_info.get('allow_ips', {})
    ip_list = allow_ips.get('ip', [])
    
    if ip in ip_list:
        print(f"IP {ip} 已在可信列表中，无需重复添加。")
        return True
    
    ip_list.append(ip)
    
    # 4. 设置新的可信IP列表
    set_url = f"https://qyapi.weixin.qq.com/cgi-bin/agent/set?access_token={access_token}"
    set_data = {
        "agentid": int(agent_id),
        "allow_ips": {
            "ip": ip_list
        }
    }
    
    set_resp = requests.post(set_url, json=set_data).json()
    if set_resp.get('errcode') == 0:
        print(f"成功添加可信IP: {ip}")
        return True
    else:
        print(f"添加可信IP失败: {set_resp}")
        return False

def send_wechat_message(content, corp_id=None, secret=None, agent_id=None):
    """
    发送企业微信消息，自动处理IP白名单问题。
    """
    corp_id = corp_id or os.getenv('WECOM_CORPID')
    secret = secret or os.getenv('WECOM_SECRET')
    agent_id = agent_id or os.getenv('WECOM_AGENTID')

    if not all([corp_id, secret, agent_id]):
        print("错误：缺少必要的配置！", file=sys.stderr)
        sys.exit(1)

    # 新增步骤：获取并添加当前运行环境的公网IP到可信列表
    print("正在获取当前运行环境的公网IP...")
    current_ip = get_public_ip()
    
    if current_ip:
        print(f"当前Runner公网IP: {current_ip}")
        print("正在尝试将此IP添加到企业微信应用的可信列表...")
        if add_trusted_ip(corp_id, secret, agent_id, current_ip):
            print("IP白名单处理成功。")
        else:
            print("警告：IP白名单处理可能未完成，将继续尝试发送消息。")
    else:
        print("警告：未能获取到公网IP，消息发送可能会因IP限制而失败。")

    # 发送消息
    try:
        pusher = WechatPush(corp_id=corp_id, secret=secret, agent_id=int(agent_id))
        result = pusher.send_text(content)
        
        if result.get('errcode') == 0:
            print(f"✅ 消息发送成功！MsgId: {result.get('msgid')}")
        else:
            print(f"❌ 消息发送失败！错误码: {result.get('errcode')}, 错误信息: {result.get('errmsg')}")
        return result
        
    except Exception as e:
        print(f"发送过程中出现异常: {e}")
        sys.exit(1)

if __name__ == "__main__":
    default_message = """【每日提醒】⏰
你好！这是来自GitHub Actions的定时消息。
现在时间是（UTC+8）下午5点。
祝你有个愉快的傍晚！"""
    
    if len(sys.argv) > 1:
        message = ' '.join(sys.argv[1:])
    else:
        message = default_message
    
    send_wechat_message(message)