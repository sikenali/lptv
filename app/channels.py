# -*- coding: utf-8 -*-
"""
频道数据库：央视频 TV 频道 pid/cnlid 对照表（来源：参考项目 + 官方抓包）。

原始 Windows 版 LX TV 由 channels.pyc 编译而来，本文件是从字节码常量中
逐条恢复的等效数据，字段定义保持一致：

    Channel(name, pid, cnlid, category, official='')

- name    : 频道显示名
- pid     : 央视频 TV 路由 pid（官方 SPA 支持 ?pid= 直达，启动竞态靠它修）
- cnlid   : 节目单(capi EPG)用频道 id；部分频道官方未暴露，留空串
- category: 面板分组，取值 '央视' / 'CGTN' / '卫视'
- official: 同名歧义消歧字段（如 CCTV-16 / CCTV-16 4K / CCTV-4K / CCTV-8K）

桥接层 get_channels() 返回的正是这五元组（dict 形式），inject.js 直接消费。
"""
from typing import List, NamedTuple, Optional


class Channel(NamedTuple):
    name: str
    pid: str
    cnlid: str
    category: str
    official: str = ""


# ---------------------------------------------------------------------------
# 央视（含 CGTN、4K/8K 超高清）
# ---------------------------------------------------------------------------
_央视: List[Channel] = [
    Channel("CCTV-1 综合", "600001859", "2024078201", "央视"),
    Channel("CCTV-2 财经", "600001800", "2024075401", "央视"),
    Channel("CCTV-3 综艺", "600001801", "2024068501", "央视"),
    Channel("CCTV-4 中文国际", "600001814", "2029797103", "央视"),
    Channel("CCTV-5 体育", "600001818", "2024078401", "央视"),
    Channel("CCTV-5+ 体育赛事", "600001817", "2024078001", "央视"),
    Channel("CCTV-6 电影", "600108442", "2013693901", "央视"),
    Channel("CCTV-7 国防军事", "600004092", "2024072001", "央视"),
    Channel("CCTV-8 电视剧", "600001803", "2029793001", "央视"),
    Channel("CCTV-9 纪录", "600004078", "2024078601", "央视"),
    Channel("CCTV-10 科教", "600001805", "2024078701", "央视"),
    Channel("CCTV-11 戏曲", "600001806", "2027248701", "央视"),
    Channel("CCTV-12 社会与法", "600001807", "2027248801", "央视"),
    Channel("CCTV-13 新闻", "600001811", "2024068601", "央视"),
    Channel("CCTV-14 少儿", "600001809", "", "央视"),          # 官方未暴露 cnlid
    Channel("CCTV-15 音乐", "600001815", "2024071301", "央视"),
    Channel("CCTV-16 奥林匹克", "600098637", "2027248901", "央视", "CCTV16"),
    Channel("CCTV-16 4K", "600099502", "2027249301", "央视", "CCTV16(4K)"),
    Channel("CCTV-4K 超高清", "600002264", "2029810301", "央视", "CCTV4K"),
    Channel("CCTV-8K 超高清", "600156816", "2020603421", "央视", "CCTV8K"),
    Channel("CCTV-17 农业农村", "600001810", "2024075501", "央视"),
]

_CGTN: List[Channel] = [
    Channel("CGTN", "600014550", "2027088301", "CGTN"),
    Channel("CGTN 法语", "600084704", "2027088401", "CGTN"),
    Channel("CGTN 俄语", "600084758", "2027088501", "CGTN"),
    Channel("CGTN 阿拉伯语", "600084759", "2027088601", "CGTN"),
    Channel("CGTN 西班牙语", "600084779", "2027088701", "CGTN"),
    Channel("CGTN 外语纪录", "600084781", "2027088801", "CGTN"),
]

_卫视: List[Channel] = [
    Channel("北京卫视", "600002309", "2027158101", "卫视"),
    Channel("江苏卫视", "600002521", "2027158201", "卫视"),
    Channel("东方卫视", "600002483", "2027158301", "卫视"),
    Channel("浙江卫视", "600002520", "2027158401", "卫视"),
    Channel("湖南卫视", "600002475", "2027158501", "卫视"),
    Channel("湖北卫视", "600002508", "2027158601", "卫视"),
    Channel("广东卫视", "600002485", "2027158701", "卫视"),
    Channel("广西卫视", "600002509", "2027158801", "卫视"),
    Channel("深圳卫视", "600002481", "2027158901", "卫视"),
    Channel("重庆卫视", "600002531", "2027159001", "卫视"),
    Channel("天津卫视", "600152137", "2027159101", "卫视"),
    Channel("山东卫视", "600002513", "2027159201", "卫视"),
    Channel("辽宁卫视", "600002505", "2027159301", "卫视"),
    Channel("安徽卫视", "600002532", "2027159401", "卫视"),
    Channel("江西卫视", "600002503", "2027159501", "卫视"),
    Channel("河南卫视", "600002525", "2027159601", "卫视"),
    Channel("河北卫视", "600002493", "2027159701", "卫视"),
    Channel("黑龙江卫视", "600002498", "2027159801", "卫视"),
    Channel("四川卫视", "600002516", "2027159901", "卫视"),
    Channel("贵州卫视", "600002490", "2027160001", "卫视"),
    Channel("云南卫视", "600190402", "2027160101", "卫视"),
    Channel("海南卫视", "600002506", "2027160201", "卫视"),
    Channel("甘肃卫视", "600190408", "2027160301", "卫视"),
    Channel("青海卫视", "600190406", "2027160401", "卫视"),
    Channel("陕西卫视", "600190400", "2027160501", "卫视"),
    Channel("山西卫视", "600190407", "2027160601", "卫视"),
    Channel("吉林卫视", "600190405", "2027160701", "卫视"),
    Channel("新疆卫视", "600152138", "2027160801", "卫视"),
    Channel("西藏卫视", "600190403", "2027160901", "卫视"),
    Channel("内蒙古卫视", "600190401", "2027161001", "卫视"),
    Channel("宁夏卫视", "600190737", "2027161101", "卫视"),
    Channel("东南卫视", "600002484", "2027161201", "卫视"),
]

# 面板 tab 顺序（与 Windows 版一致）
CATEGORIES: List[str] = ["央视", "CGTN", "卫视"]

# 扁平总表（inject.js 的 get_channels 直接返回这一份）
CHANNELS: List[Channel] = _央视 + _CGTN + _卫视
ALL_CHANNELS = CHANNELS  # 兼容旧引用


def get_channel_by_pid(pid: str) -> Optional[Channel]:
    """按 pid 精确查频道。"""
    for ch in CHANNELS:
        if ch.pid == pid:
            return ch
    return None


def channels_by_category(category: str) -> List[Channel]:
    """取某分组的频道列表。"""
    return [ch for ch in CHANNELS if ch.category == category]


def as_dict(ch: Channel) -> dict:
    return {
        "name": ch.name,
        "pid": ch.pid,
        "cnlid": ch.cnlid,
        "category": ch.category,
        "official": ch.official,
    }


def all_channels_dict() -> List[dict]:
    return [as_dict(ch) for ch in CHANNELS]


if __name__ == "__main__":
    print("频道总数:", len(CHANNELS))
    for c in CATEGORIES:
        print(f"  {c}: {len(channels_by_category(c))}")
