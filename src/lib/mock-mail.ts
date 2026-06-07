export type MessageAttachment = {
  blobId?: string;
  id: string;
  name: string;
  previewDataUrl?: string;
  size: number;
  type: string;
};

export type Message = {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  date: string;
  attachments?: MessageAttachment[];
  body?: string;
  hasAttachment?: boolean;
  htmlBody?: string;
  fromEmail?: string;
  threadId?: string;
  keywords?: Record<string, true>;
  mailboxIds?: Record<string, true>;
  mailboxName?: string;
  pinned?: boolean;
  to?: string;
  toAddresses?: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  unread?: boolean;
  count?: number;
  avatar?: string;
  avatarColor: string;
  avatarUrl?: string;
};

export const messages: Message[] = [
  {
    id: '1',
    sender: 'warroomemailreminders',
    subject: 'War Room Tasks for June 03, 2026',
    preview: 'War Room Tasks for Today There are 0 tasks planned for today and incomplete.',
    date: '07:00',
    unread: true,
    avatar: 'W',
    avatarColor: '#8D54E8',
  },
  {
    id: '2',
    sender: 'warroomemailreminders',
    subject: 'War Room Tasks for June 02, 2026',
    preview: 'War Room Tasks for Today There are 0 tasks planned for today and incomplete.',
    date: '6/2/26',
    unread: true,
    avatar: 'W',
    avatarColor: '#8D54E8',
  },
  {
    id: '3',
    sender: 'noreply-apps-notifications',
    subject: 'Summary of failures for Google Apps Script',
    preview: 'Your script, Gmail Trigger, has recently failed to finish successfully.',
    date: '6/1/26',
    unread: true,
    count: 2,
    avatar: 'N',
    avatarColor: '#EA4CA3',
  },
  {
    id: '4',
    sender: 'Martin, me',
    subject: 'Re: Hello from Geopera!',
    preview: 'Hi Eliot, Did you find the imagery that you were looking for?',
    date: '5/31/26',
    unread: true,
    count: 4,
    avatar: 'MP',
    avatarColor: '#0F6B59',
  },
  {
    id: '5',
    sender: 'warroomemailreminders',
    subject: 'War Room Tasks for May 31, 2026',
    preview: 'War Room Tasks for Today There are 0 tasks planned for today and incomplete.',
    date: '5/31/26',
    avatar: 'W',
    avatarColor: '#8D54E8',
  },
  {
    id: '6',
    sender: 'donotreply1',
    subject: 'Important Update for Trusted Travelers: Renewal Reminder',
    preview: 'Dear Trusted Traveler Program members, this is a reminder about your account.',
    date: '5/30/26',
    unread: true,
    avatar: 'D',
    avatarColor: '#2E7BEF',
  },
  {
    id: '7',
    sender: 'Barbara Jacobitti',
    subject: 'Secret Elite at Stanford/new book/review/interview',
    preview: 'The Secret Elite One: I read that concept and wanted to send a note.',
    date: '5/29/26',
    unread: true,
    avatar: 'BJ',
    avatarColor: '#707070',
  },
  {
    id: '8',
    sender: 'Fastmail Team',
    subject: 'Your new mobile mailbox prototype',
    preview: 'A first pass at the inbox experience, using mock data and native controls.',
    date: '5/28/26',
    avatar: 'F',
    avatarColor: '#135DCC',
  },
  {
    id: '9',
    sender: 'warroomemailreminders',
    subject: 'War Room Tasks for May 28, 2026',
    preview: 'War Room Tasks for Today There are 0 tasks planned for today and incomplete.',
    date: '5/28/26',
    unread: true,
    avatar: 'W',
    avatarColor: '#8D54E8',
  },
  {
    id: '10',
    sender: 'warroomemailreminders',
    subject: 'War Room Tasks for May 27, 2026',
    preview: 'War Room Tasks for Today There are 0 tasks planned for today and incomplete.',
    date: '5/27/26',
    unread: true,
    avatar: 'W',
    avatarColor: '#8D54E8',
  },
  {
    id: '11',
    sender: 'noreply-apps-notifications',
    subject: 'Summary of failures for Google Apps Script',
    preview: 'Your script, Gmail Trigger, failed to finish successfully this morning.',
    date: '5/27/26',
    count: 2,
    avatar: 'N',
    avatarColor: '#EA4CA3',
  },
  {
    id: '12',
    sender: 'Martin, me',
    subject: 'Re: Hello from Geopera!',
    preview: 'Following up on the image set and the notes from the last review.',
    date: '5/26/26',
    count: 4,
    avatar: 'MP',
    avatarColor: '#0F6B59',
  },
];

export function getMessageById(id: string | string[] | undefined) {
  const normalizedId = Array.isArray(id) ? id[0] : id;

  return messages.find((message) => message.id === normalizedId) ?? messages[0];
}
