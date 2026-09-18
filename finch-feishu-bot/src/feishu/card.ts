/**
 * 构造飞书卡片 JSON
 * 
 * 注意：飞书卡片有两种 markdown 渲染方式：
 * 1. 之前旧版: { tag: "div", text: { tag: "lark_md", content: ... } }
 *    - 这是飞书早期的轻量级行内富文本标签，只支持简单的加粗和超链接，不支持任何代码高亮、多级标题、有序列表等 Markdown 语法！导致看起来完全没有渲染。
 * 2. 飞书卡片全功能原生 Markdown 容器:
 *    { tag: "markdown", content: "..." }
 *    - 这是飞书官方专为大模型和文档设计的独立组件，原生完美支持：代码高亮 (```语言)、标题 (#/##/###)、加粗斜体、引用、分割线、表格、无序/有序列表！
 */
export function buildStreamingCard(markdownContent: string, status: 'generating' | 'completed' | 'failed' = 'generating') {
  // 去除冗余厚重的卡片外壳，只保留轻量流式打字效果
  // 如果生成中，在末尾附带一个闪烁/打字指示符
  const cursor = status === 'generating' ? ' ▍' : '';
  const renderedText = (markdownContent || '正在思考中...') + cursor;

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    // 不再使用笨重的 header 大横幅，直接像普通消息一样展示正文
    elements: [
      {
        tag: 'markdown',
        content: renderedText
      }
    ]
  };
}
