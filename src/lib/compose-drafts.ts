export type ComposeDraft = {
  body?: string;
  htmlBody?: string;
  mode?: 'reply';
  replyToMessageId?: string;
  subject?: string;
  threadId?: string;
  to?: string;
};

const composeDrafts = new Map<string, ComposeDraft>();

export function saveComposeDraft(draft: ComposeDraft) {
  const id = `compose-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  composeDrafts.set(id, draft);

  return id;
}

export function getComposeDraft(id?: string | null) {
  return id ? composeDrafts.get(id) ?? null : null;
}
