// 国际化字典管理器(md 迭代规范「国际化双轨解耦」):
// 逻辑键(node.type / slot.name / widget.name)恒定保留英文,UI 只读翻译后的
// title/label;序列化、拓扑校验、存量工作流解析永远基于原始键,零污染。
import zhCN from './i18n/zh-CN.json' with { type: 'json' };

class I18nManager {
  constructor() {
    this.locale = 'zh-CN';
    this.dict = zhCN;
  }

  setLocale(locale) {
    this.locale = locale;
    // 词典热载留给后续多语言;当前内置 zh-CN
  }

  // 分类路径翻译:「3d/mesh」→「3D/mesh」(逐段查表,未收录段保留原文)
  tCategory(categoryPath) {
    if (!categoryPath) return '未分类';
    return String(categoryPath).split('/').map((p) => this.dict.categories?.[p] || p).join('/');
  }

  // 节点标题:外部节点按 classType(如 KSampler),原生节点按 type(如 image)
  tNodeTitle(nodeType, defaultTitle) {
    return this.dict.nodes?.[nodeType]?.title || this.dict.nativeNodes?.[nodeType] || defaultTitle || nodeType;
  }

  // 输入插槽标签:先查节点专属,再查通用槽位表,兜底原名
  tInput(nodeType, slotName) {
    return this.dict.nodes?.[nodeType]?.inputs?.[slotName] || this.dict.slots?.[slotName] || slotName;
  }

  // 输出插槽标签:节点专属 → 数据类型通用名 → 原名
  tOutput(nodeType, slotName) {
    return this.dict.nodes?.[nodeType]?.outputs?.[slotName] || this.dict.types?.[slotName] || slotName;
  }

  tWidget(nodeType, widgetName) {
    return this.dict.nodes?.[nodeType]?.widgets?.[widgetName] || widgetName;
  }

  // 数据类型通用名(端口圆点 tooltip / 输出标签兜底)
  tType(type) {
    return this.dict.types?.[type] || type;
  }
}

export const i18n = new I18nManager();
