export interface Channel {
  pid: string;
  name: string;
  official: string;
  category: '央视' | 'CGTN' | '卫视' | '地方' | '其他';
  cnlid?: string;
}

export const CHANNELS: Channel[] = [
  // CCTV 系列
  { pid: '600001859', name: 'CCTV-1 综合', official: 'CCTV-1 综合', category: '央视', cnlid: '2024078201' },
  { pid: '600001800', name: 'CCTV-2 财经', official: 'CCTV-2 财经', category: '央视', cnlid: '2024075401' },
  { pid: '600001801', name: 'CCTV-3 综艺', official: 'CCTV-3 综艺', category: '央视', cnlid: '2024068501' },
  { pid: '600001814', name: 'CCTV-4 中文国际', official: 'CCTV-4 中文国际', category: '央视', cnlid: '2029797103' },
  { pid: '600001818', name: 'CCTV-5 体育', official: 'CCTV-5 体育', category: '央视', cnlid: '2024078401' },
  { pid: '600001817', name: 'CCTV-5+ 体育赛事', official: 'CCTV-5+ 体育赛事', category: '央视', cnlid: '2024078001' },
  { pid: '600108442', name: 'CCTV-6 电影', official: 'CCTV-6 电影', category: '央视', cnlid: '2013693901' },
  { pid: '600004092', name: 'CCTV-7 国防军事', official: 'CCTV-7 国防军事', category: '央视', cnlid: '' },
  { pid: '600001803', name: 'CCTV-8 电视剧', official: 'CCTV-8 电视剧', category: '央视', cnlid: '2029793001' },
  { pid: '600004078', name: 'CCTV-9 纪录', official: 'CCTV-9 纪录', category: '央视', cnlid: '2024078601' },
  { pid: '600001805', name: 'CCTV-10 科教', official: 'CCTV-10 科教', category: '央视', cnlid: '2024078701' },
  { pid: '600001806', name: 'CCTV-11 戏曲', official: 'CCTV-11 戏曲', category: '央视', cnlid: '2027248701' },
  { pid: '600001807', name: 'CCTV-12 社会与法', official: 'CCTV-12 社会与法', category: '央视', cnlid: '2027248801' },
  { pid: '600001811', name: 'CCTV-13 新闻', official: 'CCTV-13 新闻', category: '央视', cnlid: '2024068601' },
  { pid: '600001809', name: 'CCTV-14 少儿', official: 'CCTV-14 少儿', category: '央视', cnlid: '2024078201' },
  { pid: '600001815', name: 'CCTV-15 音乐', official: 'CCTV-15 音乐', category: '央视', cnlid: '2024071301' },
  { pid: '600098637', name: 'CCTV-16 奥林匹克', official: 'CCTV-16 奥林匹克', category: '央视' },
  { pid: '600099502', name: 'CCTV-16 4K', official: 'CCTV-16 4K', category: '央视' },
  { pid: '600002264', name: 'CCTV-4K 超高清', official: 'CCTV-4K 超高清', category: '央视' },
  { pid: '600156816', name: 'CCTV-8K 超高清', official: 'CCTV-8K 超高清', category: '央视' },
  { pid: '600001810', name: 'CCTV-17 农业农村', official: 'CCTV-17 农业农村', category: '央视', cnlid: '2024075501' },
  // CGTN
  { pid: '600014550', name: 'CGTN', official: 'CGTN', category: 'CGTN', cnlid: '' },
  { pid: '600084704', name: 'CGTN 法语', official: 'CGTN 法语', category: 'CGTN', cnlid: '2027088301' },
  { pid: '600084758', name: 'CGTN 俄语', official: 'CGTN 俄语', category: 'CGTN', cnlid: '2027088401' },
  { pid: '600084759', name: 'CGTN 阿拉伯语', official: 'CGTN 阿拉伯语', category: 'CGTN', cnlid: '2027088501' },
  { pid: '600084779', name: 'CGTN 西班牙语', official: 'CGTN 西班牙语', category: 'CGTN', cnlid: '2027088601' },
  { pid: '600084781', name: 'CGTN 外语纪录', official: 'CGTN 外语纪录', category: 'CGTN', cnlid: '2027088701' },
  // 卫视
  { pid: '600002309', name: '北京卫视', official: '北京卫视', category: '卫视', cnlid: '2027158101' },
  { pid: '600002521', name: '江苏卫视', official: '江苏卫视', category: '卫视', cnlid: '2027158201' },
  { pid: '600002483', name: '东方卫视', official: '东方卫视', category: '卫视', cnlid: '2027158301' },
  { pid: '600002520', name: '浙江卫视', official: '浙江卫视', category: '卫视', cnlid: '2027158401' },
  { pid: '600002475', name: '湖南卫视', official: '湖南卫视', category: '卫视', cnlid: '2027158501' },
  { pid: '600002508', name: '湖北卫视', official: '湖北卫视', category: '卫视', cnlid: '2027158601' },
  { pid: '600002485', name: '广东卫视', official: '广东卫视', category: '卫视', cnlid: '2027158701' },
  { pid: '600002509', name: '广西卫视', official: '广西卫视', category: '卫视', cnlid: '2027158801' },
  { pid: '600002481', name: '深圳卫视', official: '深圳卫视', category: '卫视', cnlid: '2027158901' },
  { pid: '600152137', name: '重庆卫视', official: '重庆卫视', category: '卫视', cnlid: '2027159001' },
  { pid: '600002513', name: '山东卫视', official: '山东卫视', category: '卫视', cnlid: '2027159101' },
  { pid: '600002505', name: '辽宁卫视', official: '辽宁卫视', category: '卫视', cnlid: '2027159201' },
  { pid: '600002532', name: '安徽卫视', official: '安徽卫视', category: '卫视', cnlid: '2027159301' },
  { pid: '600002503', name: '江西卫视', official: '江西卫视', category: '卫视', cnlid: '2027159401' },
  { pid: '600002525', name: '河南卫视', official: '河南卫视', category: '卫视', cnlid: '2027159501' },
  { pid: '600002493', name: '河北卫视', official: '河北卫视', category: '卫视', cnlid: '2027159601' },
  { pid: '600002498', name: '黑龙江卫视', official: '黑龙江卫视', category: '卫视', cnlid: '2027159701' },
  { pid: '600002516', name: '四川卫视', official: '四川卫视', category: '卫视', cnlid: '2027159801' },
  { pid: '600002490', name: '贵州卫视', official: '贵州卫视', category: '卫视', cnlid: '2027159901' },
  { pid: '600190402', name: '云南卫视', official: '云南卫视', category: '卫视', cnlid: '2027160001' },
  { pid: '600002506', name: '海南卫视', official: '海南卫视', category: '卫视', cnlid: '2027160101' },
  { pid: '600190408', name: '甘肃卫视', official: '甘肃卫视', category: '卫视', cnlid: '2027160201' },
  { pid: '600190406', name: '青海卫视', official: '青海卫视', category: '卫视', cnlid: '2027160301' },
  { pid: '600190400', name: '陕西卫视', official: '陕西卫视', category: '卫视', cnlid: '2027160401' },
  { pid: '600190407', name: '山西卫视', official: '山西卫视', category: '卫视', cnlid: '2027160501' },
  { pid: '600190405', name: '吉林卫视', official: '吉林卫视', category: '卫视', cnlid: '2027160601' },
  { pid: '600152138', name: '新疆卫视', official: '新疆卫视', category: '卫视', cnlid: '2027160701' },
  { pid: '600190403', name: '西藏卫视', official: '西藏卫视', category: '卫视', cnlid: '2027160801' },
  { pid: '600190401', name: '内蒙古卫视', official: '内蒙古卫视', category: '卫视', cnlid: '2027160901' },
  { pid: '600190737', name: '宁夏卫视', official: '宁夏卫视', category: '卫视', cnlid: '2027161001' },
  { pid: '600002484', name: '东南卫视', official: '东南卫视', category: '卫视', cnlid: '2027161101' },
];

export function getAllChannels(): Channel[] {
  return CHANNELS;
}

export function getByPid(pid: string): Channel | undefined {
  return CHANNELS.find(c => c.pid === pid);
}

export function getByCategory(category: string): Channel[] {
  return CHANNELS.filter(c => c.category === category);
}

export const CATEGORY_ORDER = ['央视', 'CGTN', '卫视', '地方', '其他'] as const;
