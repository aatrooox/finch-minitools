/**
 * 构造飞书卡片 JSON
 * 兼容飞书标准交互卡片与 Markdown 渲染
 */
export function buildStreamingCard(markdownContent: string, status: 'generating' | 'completed' | 'failed' = 'generating') {
  const statusBadge =
    status === 'generating'
      ? ' ⚡ (思考并生成中...)'
      : status === 'failed'
      ? ' ⚠️ (回答中断或出错)'
      : '';

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      title: {
        tag: 'plain_text',
        content: `Finch AI${statusBadge}`
      },
      template: status === 'failed' ? 'red' : status === 'generating' ? 'blue' : 'turquoise'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: markdownContent || '...'
        }
      },
      {
        tag: 'hr'
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: status === 'generating' ? '正在流式响应...' : '已完成 · 由 Finch 驱动'
          }
        ]
      }
    ]
  };
}
