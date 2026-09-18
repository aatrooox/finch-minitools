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

/**
 * 构造问答选择卡片 (SessionQuestionWait)
 */
export function buildQuestionCard(params: {
  requestId: string;
  header: string;
  question: string;
  options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
}) {
  const { requestId, header, question, options } = params;

  let mdContent = `**${question}**\n\n`;
  options.forEach((opt, idx) => {
    mdContent += `${idx + 1}. **${opt.label}**${opt.description ? ` - ${opt.description}` : ''}\n`;
  });

  const buttons = options.slice(0, 5).map((opt, idx) => ({
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: `${idx + 1}. ${opt.label}`.slice(0, 20)
    },
    type: idx === 0 ? 'primary' : 'default',
    value: {
      waitRequestId: requestId,
      kind: 'question',
      header,
      answer: opt.label,
      index: idx + 1
    }
  }));

  const elements: any[] = [
    {
      tag: 'markdown',
      content: mdContent
    }
  ];

  if (buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: buttons
    });
  }

  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: '💡 提示：可直接点击上方选项，或在聊天中回复序号（如 1、2）'
      }
    ]
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: header || '请选择或确认'
      }
    },
    elements
  };
}

/**
 * 问答选择已回答后的状态卡片
 */
export function buildQuestionResolvedCard(params: {
  header: string;
  question: string;
  selectedAnswer: string;
  operatorName?: string;
}) {
  const { header, question, selectedAnswer, operatorName } = params;
  const who = operatorName ? ` (操作人: ${operatorName})` : '';

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: header || '已回答'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: `**${question}**\n\n> 🎯 **已选择/回复**: ${selectedAnswer}`
      },
      {
        tag: 'hr'
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `✅ 已提交${who}`
          }
        ]
      }
    ]
  };
}

/**
 * 构造权限申请卡片 (SessionPermissionWait)
 */
export function buildPermissionWaitCard(params: {
  requestId: string;
  toolName: string;
  toolTitle?: string;
  toolInput?: unknown;
}) {
  const { requestId, toolName, toolTitle, toolInput } = params;

  let inputSummary = '';
  if (toolInput) {
    try {
      inputSummary = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
    } catch {
      inputSummary = String(toolInput);
    }
  }

  const mdContent = `Agent 正在请求执行以下工具操作：\n\n**工具名称**: \`${toolName}\`${toolTitle ? ` (${toolTitle})` : ''}\n` +
    (inputSummary ? `\n\`\`\`json\n${inputSummary.slice(0, 500)}\n\`\`\`\n` : '');

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '⚠️ 操作授权申请'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: mdContent
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '允许'
            },
            type: 'primary',
            value: {
              waitRequestId: requestId,
              kind: 'permission',
              allow: true
            }
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '拒绝'
            },
            type: 'danger',
            value: {
              waitRequestId: requestId,
              kind: 'permission',
              allow: false
            }
          }
        ]
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '💡 提示：可点击按钮授权，或在聊天中直接回复“允许/同意”或“拒绝”'
          }
        ]
      }
    ]
  };
}

/**
 * 权限状态结算后的卡片
 */
export function buildPermissionWaitResolvedCard(params: {
  toolName: string;
  allow: boolean;
  operatorName?: string;
}) {
  const { toolName, allow, operatorName } = params;
  const who = operatorName ? ` (操作人: ${operatorName})` : '';

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: allow ? 'green' : 'red',
      title: {
        tag: 'plain_text',
        content: allow ? '✅ 权限已授权' : '❌ 权限已拒绝'
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: `工具 \`${toolName}\` 执行申请：**${allow ? '已允许' : '已拒绝'}**`
      },
      {
        tag: 'hr'
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `${allow ? '已允许授权' : '已拒绝请求'}${who}`
          }
        ]
      }
    ]
  };
}
