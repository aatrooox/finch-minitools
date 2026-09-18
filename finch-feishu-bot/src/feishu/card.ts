export const DEFAULT_ELEMENT_ID = 'stream_content_md';

/**
 * 飞书卡片 2.0 (Schema 2.0)
 * 官方标准流式 Markdown 卡片结构
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

/**
 * 构造带有 Yes / No 操作按钮的交互询问卡片
 * 用户在飞书点击时会触发 card.action.trigger 回调
 */
export function buildActionConfirmCard(params: {
  actionId: string;
  title: string;
  content: string;
  yesLabel?: string;
  noLabel?: string;
}) {
  const { actionId, title, content, yesLabel = '是 / 允许', noLabel = '否 / 拒绝' } = params;

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: title || '需要您的确认'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: yesLabel
            },
            type: 'primary',
            value: {
              actionId,
              decision: 'yes'
            }
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: noLabel
            },
            type: 'danger',
            value: {
              actionId,
              decision: 'no'
            }
          }
        ]
      }
    ]
  };
}

/**
 * 用户点击按钮后，将卡片就地更新为已确认/已拒绝的状态卡片（防止重复点击）
 */
export function buildActionResolvedCard(params: {
  title: string;
  content: string;
  decision: 'yes' | 'no';
  operatorName?: string;
}) {
  const { title, content, decision, operatorName } = params;
  const isYes = decision === 'yes';
  const statusText = isYes ? '✅ 已允许 / 授权' : '❌ 已拒绝 / 终止';
  const who = operatorName ? ` (操作人: ${operatorName})` : '';

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: isYes ? 'green' : 'red',
      title: {
        tag: 'plain_text',
        content: title || '操作确认结果'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content
      },
      {
        tag: 'hr'
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `${statusText}${who}`
          }
        ]
      }
    ]
  };
}
