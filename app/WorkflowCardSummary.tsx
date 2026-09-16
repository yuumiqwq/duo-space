import type { ClaimWorkflow } from './collaboration-types';
import { collaborationDate, collaborationDateLabel } from './collaboration-view';
import { TaskNoticeDot } from './TaskNoticeDot';

export function WorkflowCardSummary({ item, name, noticeIds }: { item: ClaimWorkflow; name: (id: string) => string; noticeIds: string[] }) {
  const date = collaborationDate(item.fields);
  return <span className="coop-workflow-summary">
    <strong><TaskNoticeDot ids={noticeIds} />{item.title}</strong>
    <span className="coop-workflow-meta"><small>{name(item.claimantId)} 认领 · {name(item.reviewerId)} 审批</small>
      {date && <time className="coop-task-date" dateTime={date}>{collaborationDateLabel(item.fields)}</time>}
    </span>
    {item.fields.priority !== 0 && <span className="coop-priority-label">{{ 1: '低', 3: '中', 5: '高' }[item.fields.priority]}优先级</span>}
  </span>;
}
