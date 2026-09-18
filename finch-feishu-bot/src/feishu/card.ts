export const DEFAULT_ELEMENT_ID = 'stream_content_md';

/**
 * 飞书卡片 2.0 (Schema 2.0)
 * 官方标准流式 Markdown 卡片结构
 * 
 * 优势：
 * 1. 客户端原生支持 streaming_mode: true，自动附带原生流式打字机动画和优雅的光标效果，不再需要开发者手拼黑块光标！
 * 2. 属于独立的全功能 Markdown 容器，完美原生渲染多级标题（#、##、###）、代码块高亮、表格、引用等！
 */
export function buildCardkitStreamingCard(initialText: string = '') {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: {
        content: '正在生成回答...'
      },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 1 },
        print_strategy: 'fast'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: DEFAULT_ELEMENT_ID,
          content: initialText
        }
      ]
    }
  };
}
